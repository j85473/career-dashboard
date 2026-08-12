import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';
import { cleanHtmlText, findLikelyDuplicateJob } from '@/lib/jobIngestion';
import { resolveRedirectUrl } from '@/lib/atsRedirect';
import { buildSafeJinaReaderUrl } from '@/lib/safeExternalFetch';
import { parseHttpUrl, urlMatchesAnyHost } from '@/lib/urlHost';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import { decideJdRecovery } from '@/lib/jdRecoveryPolicy';

const ACTIVE_JD_STATUSES = ['pending_af', 'inbox'];

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

export async function POST(_request: Request) {
  void _request;
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
        const claimedJobs = await prisma.job.findMany({ where: { jdBatchId: runId } });
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
        ) => prisma.$transaction(async (tx) => {
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
          try {
            const existingDecision = decideJdRecovery(job.description, job.scoreAttempts);
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

            let markdown = '';
            let finalResolvedUrl = job.url;
            let newTitle: string | undefined = undefined;
            let newCompany: string | undefined = undefined;

            if (job.url && parseHttpUrl(job.url)) {
              if (urlMatchesAnyHost(job.url, ['adzuna.com', 'himalayas.app'])) {
                const resolvedUrl = await resolveRedirectUrl(job.url);
                finalResolvedUrl = cleanUrl(resolvedUrl);
              } else {
                finalResolvedUrl = cleanUrl(job.url);
              }

              // Step 1: Try ATS specific API (Greenhouse, Lever, Workday, etc.)
              const atsResult = await scrapeAtsApi(finalResolvedUrl);
              if (atsResult && atsResult.text.length > 500) {
                markdown = atsResult.text;
                if (atsResult.title) newTitle = atsResult.title;
                if (atsResult.atsSlug) {
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

                const jinaUrl = await buildSafeJinaReaderUrl(finalResolvedUrl);
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

            const recoveryDecision = decideJdRecovery(markdown, job.scoreAttempts);
            const resolvedInputChanges = [
              finalResolvedUrl !== job.url ? 'url' : null,
              markdown && markdown !== job.description ? 'description' : null,
              newTitle && newTitle !== job.title ? 'title' : null,
              newCompany && newCompany !== job.company ? 'company' : null,
            ].filter((field): field is string => field !== null && field !== undefined && field !== '');

            if (recoveryDecision.kind === 'ready') {
              markdown = recoveryDecision.text;
              const duplicate = await findLikelyDuplicateJob({
                title: newTitle || job.title,
                company: newCompany || job.company,
                description: markdown,
                location: job.location,
                url: finalResolvedUrl,
                canonicalUrl: finalResolvedUrl,
                source: job.source,
                sourceId: job.sourceId
              });

              if (duplicate && duplicate.id !== job.id) {
                await updateClaimedInputs(job, {
                    status: 'archived',
                    passReason: 'Duplicate description found after JD extraction',
                    scoringStatus: 'skipped',
                    jdBatchId: null,
                    description: markdown,
                    url: finalResolvedUrl,
                    ...(newTitle ? { title: newTitle } : {}),
                    ...(newCompany ? { company: newCompany } : {}),
                  }, resolvedInputChanges);
                await new Promise(r => setTimeout(r, 1000));
              } else {
                // Jina successfully found the JD. Queue it for local heuristic scoring!
                await updateClaimedInputs(job, {
                    description: markdown,
                    url: finalResolvedUrl,
                    jdBatchId: null,
                    // A leftover lease makes the job unclaimable by local scoring.
                    batchJobId: null,
                    scoreAttempts: 0,
                    scoringStatus: 'queued',
                    ...(newTitle ? { title: newTitle } : {}),
                    ...(newCompany ? { company: newCompany } : {}),
                  }, resolvedInputChanges);
                await new Promise(r => setTimeout(r, 1000)); // Rate limit Jina
              }
            } else {
              // Do not reset the retry budget merely because an extractor
              // returned a long page. Only a complete-enough JD can proceed.
              await updateClaimedInputs(job, {
                  url: finalResolvedUrl,
                  jdBatchId: null,
                  scoreAttempts: recoveryDecision.nextAttempts,
                  scoreError: `JD recovery rejected: ${recoveryDecision.reason}.`,
                  scoringStatus: recoveryDecision.terminal ? 'failed' : 'needs_jd',
                  ...(recoveryDecision.terminal ? {
                    passReason: 'JD recovery failed after 3 attempts. Manual review required.',
                    status: 'dismissed',
                  } : {})
                }, resolvedInputChanges.filter((field) => field === 'url'));
              await new Promise(r => setTimeout(r, 1000));
            }
          } catch (jobErr: unknown) {
            console.error(`Failed to process JD for job ${job.id}:`, jobErr);
            const failedDecision = decideJdRecovery('', job.scoreAttempts);
            
            await prisma.job.updateMany({
              where: claimedUpdateWhere(job),
              data: {
                jdBatchId: null,
                scoreAttempts: failedDecision.kind === 'retry' ? failedDecision.nextAttempts : job.scoreAttempts + 1,
                scoringStatus: failedDecision.kind === 'retry' && failedDecision.terminal ? 'failed' : 'needs_jd',
                ...(failedDecision.kind === 'retry' && failedDecision.terminal ? {
                  scoreError: jobErr instanceof Error ? jobErr.message : 'Error executing search',
                  passReason: 'Error calling Jina. Manual review required.',
                  status: 'dismissed',
                } : {})
              }
            });
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // Automatically trigger local heuristic scoring since it's fast and local.
        try {
          await scoreJobs(undefined, undefined, {
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
