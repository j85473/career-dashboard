import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';
import { cleanHtmlText, findLikelyDuplicateJob } from '@/lib/jobIngestion';
import { resolveRedirectUrl } from '@/lib/atsRedirect';

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
      take: 10 // Limit batch size for Jina extraction
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
          updatedAt: job.updatedAt,
          url: job.url,
        });

        for (const job of claimedJobs) {
          try {
            let markdown = '';
            let finalResolvedUrl = job.url;
            let newTitle: string | undefined = undefined;
            let newCompany: string | undefined = undefined;

            if (job.url && job.url.startsWith('http')) {
              const resolvedUrl = await resolveRedirectUrl(job.url);
              finalResolvedUrl = cleanUrl(resolvedUrl);

              // Step 1: Try ATS specific API (Greenhouse, Lever, Workday, etc.)
              const atsResult = await scrapeAtsApi(finalResolvedUrl);
              if (atsResult && atsResult.text.length > 500) {
                markdown = atsResult.text;
                if (atsResult.title) newTitle = atsResult.title;
                if (atsResult.atsSlug) {
                   const lowerCompany = (job.company || '').toLowerCase();
                   if (lowerCompany.includes('job-boards') || lowerCompany.includes('greenhouse.io') || lowerCompany.includes('lever.co') || lowerCompany.includes('ashbyhq')) {
                      newCompany = atsResult.atsSlug.charAt(0).toUpperCase() + atsResult.atsSlug.slice(1);
                   }
                }
              } else {
                // Step 2: Fallback to Jina Extraction
                const JINA_KEY = process.env.JINA_API_KEY;
                const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
                if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`;

                const jinaRes = await fetch(`https://r.jina.ai/${finalResolvedUrl}`, { 
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

            const botPhrases = /verify you are human|access denied|enable javascript|captcha/i;
            const isValidMarkdown = markdown && markdown.length >= 500 && !botPhrases.test(markdown);

            if (isValidMarkdown) {
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
                await prisma.job.updateMany({
                  where: claimedUpdateWhere(job),
                  data: {
                    status: 'archived',
                    passReason: 'Duplicate description found after JD extraction',
                    scoringStatus: 'skipped',
                    jdBatchId: null,
                    description: markdown,
                    url: finalResolvedUrl,
                    ...(newTitle ? { title: newTitle } : {}),
                    ...(newCompany ? { company: newCompany } : {}),
                  }
                });
                await new Promise(r => setTimeout(r, 1000));
              } else {
                // Jina successfully found the JD. Queue it for local heuristic scoring!
                await prisma.job.updateMany({
                  where: claimedUpdateWhere(job),
                  data: {
                    description: markdown,
                    url: finalResolvedUrl,
                    jdBatchId: null,
                    scoreAttempts: 0,
                    scoringStatus: 'queued',
                    ...(newTitle ? { title: newTitle } : {}),
                    ...(newCompany ? { company: newCompany } : {}),
                  }
                });
                await new Promise(r => setTimeout(r, 1000)); // Rate limit Jina
              }
            } else if (job.description && job.description.length >= 400) {
              // Fallback to existing short description
              await prisma.job.updateMany({
                where: claimedUpdateWhere(job),
                data: {
                  url: finalResolvedUrl,
                  jdBatchId: null,
                  scoreAttempts: 0,
                  scoringStatus: 'queued'
                }
              });
            } else {
              // Jina failed to find it or it's too short -> Increment attempt or Dismiss
              const nextAttempts = job.scoreAttempts + 1;
              const isDead = nextAttempts >= 3;

              await prisma.job.updateMany({
                where: claimedUpdateWhere(job),
                data: {
                  url: finalResolvedUrl,
                  jdBatchId: null,
                  scoreAttempts: { increment: 1 },
                  scoringStatus: isDead ? 'failed' : 'needs_jd',
                  ...(isDead ? {
                    scoreError: 'Jina could not extract sufficient markdown.',
                    passReason: 'Jina could not parse JD. Manual review required.',
                    status: 'dismissed',
                  } : {})
                }
              });
              await new Promise(r => setTimeout(r, 1000));
            }
          } catch (jobErr: unknown) {
            console.error(`Failed to process JD for job ${job.id}:`, jobErr);
            const nextAttempts = job.scoreAttempts + 1;
            const isDead = nextAttempts >= 3;
            
            await prisma.job.updateMany({
              where: claimedUpdateWhere(job),
              data: {
                jdBatchId: null,
                scoreAttempts: { increment: 1 },
                scoringStatus: isDead ? 'failed' : 'needs_jd',
                ...(isDead ? {
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
