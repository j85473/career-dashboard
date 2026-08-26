import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';
import {
  cleanHtmlText,
  fetchGlassdoorJobDescription,
  findLikelyDuplicateJob,
  generateV4Fingerprint,
  GLASSDOOR_SOURCE,
} from '@/lib/jobIngestion';
import { resolveRedirectUrl } from '@/lib/atsRedirect';
import { buildSafeJinaReaderUrl } from '@/lib/safeExternalFetch';
import { parseHttpUrl, urlMatchesAnyHost } from '@/lib/urlHost';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import {
  buildAggregatorDiscardUpdate,
  buildClosedPostingUpdate,
  buildTerminalJdRecoveryUpdate,
  decideJdRecovery,
} from '@/lib/jdRecoveryPolicy';
import { isSnippetOnlyAggregator } from '@/lib/ingestionSourceKind';
import { evaluateAuthoritativeMetadata, hasAuthoritativeMetadata } from '@/lib/authoritativeMetadataGate';
import { isStructuredAtsSource } from '@/lib/jobDescriptionQuality';
import { assessJobInfoLanguage } from '@/lib/jobLanguage';
import { preferredJdSourceUrl } from '@/lib/jobSourceProvenance';
import {
  automatedLifecycleIsProtected,
  manualImportInformationalScoringUpdate,
} from '@/lib/manualImportPolicy';
import { withIngestionTransactionSlot } from '@/lib/ingestionConcurrency';
import { withProviderTransactionRetry } from '@/lib/ingestionControl';

const ACTIVE_JD_STATUSES = ['pending_af', 'inbox'];

function withBatchJdTransaction<T>(
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withProviderTransactionRetry(() => withIngestionTransactionSlot(
    () => prisma.$transaction(action, {
      maxWait: 10_000,
      timeout: 15_000,
    }),
  ));
}

function cleanUrl(url: string) {
  try {
    const parsed = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach(param => {
      parsed.searchParams.delete(param);
    });
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function POST(request: Request) {
  try {
    const queuedJobs = await prisma.job.findMany({
      where: { 
        scoringStatus: 'needs_jd',
        jdBatchId: null,
        status: { in: ['pending_af', 'inbox'] },
        scoreAttempts: { lt: 3 }
      },
      take: 10, // Limit batch size for Jina extraction
      // Failed rows update their timestamp when they return to needs_jd. This
      // ordering moves them behind untouched work instead of letting the same
      // ten rows starve the queue indefinitely.
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    });

    if (queuedJobs.length === 0) {
      return NextResponse.json({ message: 'No jobs queued for JD Batch submission.' });
    }

    // 1. Atomic claim: Mark jobs as processing using a transaction to avoid race conditions
    const runId = `run-${crypto.randomUUID()}`;
    const claimResult = await prisma.job.updateMany({
      where: { 
        id: { in: queuedJobs.map(j => j.id) },
        jdBatchId: null,
        scoringStatus: 'needs_jd',
        status: { in: ['pending_af', 'inbox'] },
      },
      data: { jdBatchId: runId }
    });

    if (claimResult.count === 0) {
      return NextResponse.json({ message: 'Jobs were already claimed.' });
    }

    // 2. Process the claimed jobs synchronously
    try {
      // Re-fetch only the claimed jobs (to handle partial overlap).
        const claimedJobs = await prisma.job.findMany({
          where: { jdBatchId: runId },
          include: {
            observations: {
              select: { source: true, url: true },
            },
          },
        });
        const claimedUpdateWhere = (job: typeof claimedJobs[number]) => ({
          id: job.id,
          jdBatchId: runId,
          scoringStatus: 'needs_jd',
          status: { in: ACTIVE_JD_STATUSES },
          
          url: job.url,
        });
        const updateClaimedInputs = (
          job: typeof claimedJobs[number],
          data: Prisma.JobUpdateManyMutationInput,
          changedFields: readonly string[],
        ) => withBatchJdTransaction(async (tx) => {
          const result = await tx.job.updateMany({ where: claimedUpdateWhere(job), data });
          if (result.count === 1 && changedFields.length > 0) {
            await invalidateActiveJobScores({
              jobId: job.id,
              source: job.source,
              sourceId: job.sourceId,
              changedFields,
              route: 'batch_jd_resolution',
            }, tx);
          }
          return result;
        });

        for (const job of claimedJobs) {
          if (request.signal.aborted) break;
          try {
            const lifecycleProtected = automatedLifecycleIsProtected(job);
            const existingDecision = decideJdRecovery(job.description, job.scoreAttempts, {
              structuredSource: isStructuredAtsSource(job.source),
            });
            if (existingDecision.kind === 'closed') {
              await updateClaimedInputs(
                job,
                lifecycleProtected
                  ? manualImportInformationalScoringUpdate(
                      'automated closed-posting signal preserved as informational only.',
                    )
                  : buildClosedPostingUpdate(),
                [],
              );
              continue;
            }

            // Every source gets the language-only portion of local filtering
            // before an ATS request or Jina call. Sparse/ambiguous metadata
            // fails open; affirmative non-English information is a dismissal.
            const language = assessJobInfoLanguage({
              title: job.title,
              description: job.description,
            });
            if (language.isAffirmativelyNonEnglish) {
              await updateClaimedInputs(job, {
                ...(lifecycleProtected
                  ? manualImportInformationalScoringUpdate(
                      `automated language signal preserved as informational only: ${language.reason}`,
                    )
                  : {
                      jdBatchId: null,
                      batchJobId: null,
                      scoringStatus: 'skipped' as const,
                      status: 'dismissed',
                      passReason: language.reason,
                      scoreAttempts: 0,
                      scoreError: null,
                    }),
              }, []);
              continue;
            }

            if (existingDecision.kind === 'ready') {
              await updateClaimedInputs(job, {
                jdBatchId: null,
                batchJobId: null,
                scoringStatus: 'queued',
                scoreAttempts: 0,
                scoreError: null,
                passReason: null,
              }, []);
              continue;
            }

            // A direct ATS board (and Glassdoor's search result) states its own
            // title, company and location, so the record is authoritative the
            // moment it lands and JD recovery cannot improve it. Apply the same
            // deterministic gate `jobScoring` and the retroactive triage script
            // use before paying for a details request or a Jina call.
            // Location-based fit remains Aim-owned; this gate only applies the
            // existing safe prefilter and local-triage rules.
            if (hasAuthoritativeMetadata(job.source)) {
              const metadataVerdict = evaluateAuthoritativeMetadata({
                title: job.title,
                company: job.company,
                location: job.location,
                url: job.url,
              });
              if (!metadataVerdict.passes) {
                await updateClaimedInputs(job, {
                  ...(lifecycleProtected
                    ? manualImportInformationalScoringUpdate(
                        `automated metadata signal preserved as informational only: ${metadataVerdict.reason}`,
                      )
                    : {
                        jdBatchId: null,
                        batchJobId: null,
                        scoringStatus: 'skipped' as const,
                        status: 'dismissed',
                        passReason: metadataVerdict.reason,
                        scoreAttempts: 0,
                        scoreError: null,
                      }),
                }, []);
                continue;
              }
            }

            let markdown = '';
            let finalResolvedUrl = job.url;
            let newTitle: string | undefined = undefined;
            let newCompany: string | undefined = undefined;
            let newLocation: string | undefined = undefined;
            let recoveredFromStructuredSource = false;
            const sourceExtractionUrl = preferredJdSourceUrl({
              source: job.source,
              jobUrl: job.url,
              observations: job.observations,
            });

            if (job.source === GLASSDOOR_SOURCE) {
              // Glassdoor search results have no JD. Their listing ID plus the
              // saved search query string feed the provider's details API;
              // the Glassdoor tracking page itself is an anti-bot challenge.
              markdown = await fetchGlassdoorJobDescription(job) || '';
            } else if (job.url && parseHttpUrl(job.url)) {
              let extractionUrl = sourceExtractionUrl && parseHttpUrl(sourceExtractionUrl)
                ? sourceExtractionUrl
                : job.url;
              if (urlMatchesAnyHost(job.url, ['adzuna.com', 'himalayas.app'])) {
                const resolvedUrl = await resolveRedirectUrl(job.url);
                finalResolvedUrl = cleanUrl(resolvedUrl);
                extractionUrl = finalResolvedUrl;
              } else {
                finalResolvedUrl = cleanUrl(job.url);
              }

              // Step 1: Try ATS specific API (Greenhouse, Lever, Workday, etc.)
              const atsResult = await scrapeAtsApi(extractionUrl);
              // Workday's detail response carries the complete primary plus
              // additional-location list and its authoritative hiring entity.
              // Preserve both even if the description itself is too short and
              // recovery falls through to Jina.
              if (atsResult?.location) newLocation = atsResult.location;
              if (atsResult?.title) newTitle = atsResult.title;
              if (atsResult?.company) newCompany = atsResult.company;
              if (atsResult && atsResult.text.length > 500) {
                markdown = atsResult.text;
                recoveredFromStructuredSource = true;
                if (!newCompany && atsResult.atsSlug) {
                   const lowerCompany = (job.company || '').toLowerCase();
                   if (/job-boards|greenhouse\.io|lever\.co|ashbyhq/i.test(lowerCompany)) {
                      newCompany = atsResult.atsSlug.charAt(0).toUpperCase() + atsResult.atsSlug.slice(1);
                   }
                }
              } else {
                // Step 2: Fallback to Jina Extraction
                const JINA_KEY = process.env.JINA_API_KEY;
                const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
                if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`;

                const jinaUrl = await buildSafeJinaReaderUrl(extractionUrl);
                const jinaRes = await fetch(jinaUrl, {
                  headers,
                  signal: AbortSignal.timeout(20000) 
                });
                if (!jinaRes.ok && (jinaRes.status === 429 || jinaRes.status >= 500)) {
                  throw new Error(`Jina retryable error: ${jinaRes.status}`);
                }
                if (jinaRes.ok) {
                  markdown = await jinaRes.text();
                }
              }
            }

            if (markdown) {
              markdown = cleanHtmlText(markdown);
              markdown = markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
            }

            const recoveryDecision = decideJdRecovery(markdown, job.scoreAttempts, {
              structuredSource: recoveredFromStructuredSource,
            });
            const resolvedInputChanges = [
              finalResolvedUrl !== job.url ? 'url' : null,
              markdown && markdown !== job.description ? 'description' : null,
              newTitle && newTitle !== job.title ? 'title' : null,
              newCompany && newCompany !== job.company ? 'company' : null,
              newLocation && newLocation !== job.location ? 'location' : null,
            ].filter((field): field is string => field !== null && field !== undefined && field !== '');
            const resolvedTitle = newTitle || job.title;
            const resolvedCompany = newCompany || job.company;
            const resolvedLocation = newLocation || job.location || 'Unknown Location';
            const scoringIdentityChanged = resolvedTitle !== job.title
              || resolvedCompany !== job.company
              || resolvedLocation !== job.location;
            const resolvedMetadataUpdate = {
              ...(newTitle ? { title: newTitle } : {}),
              ...(newCompany ? { company: newCompany } : {}),
              ...(newLocation ? { location: newLocation } : {}),
              ...(scoringIdentityChanged
                ? { identityFingerprint: generateV4Fingerprint(resolvedTitle, resolvedCompany, resolvedLocation) }
                : {}),
            };

            if (recoveryDecision.kind === 'closed') {
              await updateClaimedInputs(job, {
                ...(lifecycleProtected
                  ? manualImportInformationalScoringUpdate(
                      'automated recovered-page closure signal preserved as informational only.',
                    )
                  : buildClosedPostingUpdate()),
                url: finalResolvedUrl,
                ...resolvedMetadataUpdate,
              }, resolvedInputChanges.filter((field) => field !== 'description'));
              await new Promise(r => setTimeout(r, 1000));
            } else if (recoveryDecision.kind === 'ready') {
              markdown = recoveryDecision.text;
              const duplicate = await findLikelyDuplicateJob({
                title: resolvedTitle,
                company: resolvedCompany,
                description: markdown,
                location: resolvedLocation,
                url: finalResolvedUrl,
                canonicalUrl: finalResolvedUrl,
                source: job.source,
                sourceId: job.sourceId
              });

              if (duplicate && duplicate.id !== job.id && !lifecycleProtected) {
                await updateClaimedInputs(job, {
                    status: 'archived',
                    passReason: 'Duplicate description found after JD extraction',
                    scoringStatus: 'skipped',
                    jdBatchId: null,
                    description: markdown,
                    url: finalResolvedUrl,
                    ...resolvedMetadataUpdate,
                  }, resolvedInputChanges);
                await new Promise(r => setTimeout(r, 1000));
              } else {
                // JD recovery found a usable posting. Queue it for local heuristic scoring.
                await updateClaimedInputs(job, {
                    description: markdown,
                    url: finalResolvedUrl,
                    jdBatchId: null,
                    // A leftover lease makes the job unclaimable by local scoring.
                    batchJobId: null,
                    scoreAttempts: 0,
                    scoringStatus: 'queued',
                    ...resolvedMetadataUpdate,
                  }, resolvedInputChanges);
                await new Promise(r => setTimeout(r, 1000)); // Rate limit Jina
              }
            } else {
              // Do not reset the retry budget merely because an extractor
              // returned a long page. Only a complete-enough JD can proceed.
              const scoreError = `JD recovery rejected: ${recoveryDecision.reason}.`;
              await updateClaimedInputs(job, {
                  url: finalResolvedUrl,
                  jdBatchId: null,
                  ...resolvedMetadataUpdate,
                  ...(recoveryDecision.terminal
                    // An aggregator snippet is not fixable by a human, so it is
                    // dismissed rather than queued for review.
                    ? (isSnippetOnlyAggregator(job.source)
                        ? buildAggregatorDiscardUpdate(scoreError)
                        : buildTerminalJdRecoveryUpdate(scoreError))
                    : {
                        scoreAttempts: recoveryDecision.nextAttempts,
                        scoreError,
                        scoringStatus: 'needs_jd',
                      }),
                }, resolvedInputChanges.filter((field) => field !== 'description'));
              await new Promise(r => setTimeout(r, 1000));
            }
          } catch (jobErr: unknown) {
            console.error(`Failed to process JD for job ${job.id}:`, jobErr);
            const failedDecision = decideJdRecovery('', job.scoreAttempts);
            const scoreError = jobErr instanceof Error ? jobErr.message : 'Error executing search';
            
            await prisma.job.updateMany({
              where: claimedUpdateWhere(job),
              data: {
                jdBatchId: null,
                ...(failedDecision.kind === 'retry' && failedDecision.terminal
                  ? (isSnippetOnlyAggregator(job.source)
                      ? buildAggregatorDiscardUpdate(scoreError)
                      : buildTerminalJdRecoveryUpdate(scoreError, 'JD recovery failed. Manual review required.'))
                  : {
                      scoreAttempts: failedDecision.kind === 'retry' ? failedDecision.nextAttempts : job.scoreAttempts + 1,
                      scoringStatus: 'needs_jd',
                      scoreError,
                    }),
              }
            });
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // Automatically trigger local heuristic scoring since it's fast and local.
        try {
          await scoreJobs(undefined, request.signal, {
            jobIds: claimedJobs.map((job) => job.id),
            limit: claimedJobs.length || 1,
          });
        } catch(e) {
          console.error('Failed to trigger scoreJobs automatically:', e);
        }
      } finally {
        // A user may apply to or edit a job while extraction is running. Those
      // updates intentionally fail the guarded writes above; always release
      // any remaining batch lease so the job is not stranded.
      await prisma.job.updateMany({
        where: { jdBatchId: runId },
        data: { jdBatchId: null },
      }).catch((error) => console.error('Failed to release JD batch leases:', error));
    }

    return NextResponse.json({ message: 'JD Extraction completed', count: claimResult.count });
  } catch (error: unknown) {
    console.error('JD Submit failed:', error);
    return NextResponse.json({ error: 'Failed to submit', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
