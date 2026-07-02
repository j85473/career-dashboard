import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';
import { cleanHtmlText } from '@/lib/jobIngestion';

function cleanUrl(url: string) {
  try {
    const parsed = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach(param => {
      parsed.searchParams.delete(param);
    });
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

export async function POST(request: Request) {
  try {
    const queuedJobs = await prisma.job.findMany({
      where: { 
        scoringStatus: 'needs_jd',
        jdBatchId: null,
        status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] },
        scoreAttempts: { lt: 3 }
      },
      take: 50 // Limit batch size for atomic claim
    });

    if (queuedJobs.length === 0) {
      return NextResponse.json({ message: 'No jobs queued for JD Batch submission.' });
    }

    // 1. Atomic claim: Mark jobs as processing using a transaction to avoid race conditions
    const runId = `run-${crypto.randomUUID()}`;
    const claimResult = await prisma.job.updateMany({
      where: { 
        id: { in: queuedJobs.map(j => j.id) },
        jdBatchId: null
      },
      data: { jdBatchId: runId }
    });

    if (claimResult.count === 0) {
      return NextResponse.json({ message: 'Jobs were already claimed.' });
    }

    // 2. Fire and forget background processor
    (async () => {
      // Re-fetch only the claimed jobs (to handle partial overlap)
      const claimedJobs = await prisma.job.findMany({ where: { jdBatchId: runId } });
      
      for (const job of claimedJobs) {
        try {
          let markdown = '';
          
          if (job.url && job.url.startsWith('http')) {
            const cleanedUrl = cleanUrl(job.url);
            
            // Step 1: Try ATS specific API (Greenhouse, Lever, Workday, etc.)
            const atsResult = await scrapeAtsApi(cleanedUrl);
            if (atsResult && atsResult.text.length > 500) {
                markdown = atsResult.text;
            } else {
                // Step 2: Fallback to Jina Extraction
                const jinaRes = await fetch(`https://r.jina.ai/${cleanedUrl}`, { signal: AbortSignal.timeout(20000) });
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
            // Jina successfully found the JD. Queue it for local heuristic scoring!
            await prisma.job.update({
              where: { id: job.id },
              data: {
                description: markdown,
                jdBatchId: null,
                scoringStatus: 'queued', 
                fitCategory: 'unscored'
              }
            });
            await new Promise(r => setTimeout(r, 1000)); // Rate limit Jina
          } else if (job.description && job.description.length >= 400) {
            // Fallback to existing short description
            await prisma.job.update({
              where: { id: job.id },
              data: {
                jdBatchId: null,
                scoreAttempts: { increment: 1 },
                scoringStatus: 'queued',
                fitCategory: 'unscored'
              }
            });
          } else {
            // Jina failed to find it or it's too short -> Increment attempt or Graveyard
            const nextAttempts = job.scoreAttempts + 1;
            const isDead = nextAttempts >= 3;
            
            await prisma.job.update({
              where: { id: job.id },
              data: { 
                jdBatchId: null,
                scoreAttempts: { increment: 1 },
                scoringStatus: isDead ? 'failed' : 'needs_jd',
                ...(isDead ? {
                  scoreError: 'Jina could not extract sufficient markdown.',
                  fitCategory: 'rejected',
                  passReason: 'Jina could not parse JD. Manual review required.'
                } : {})
              }
            });
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (jobErr: any) {
          console.error(`Failed to process JD for job ${job.id}:`, jobErr);
          const nextAttempts = job.scoreAttempts + 1;
          const isDead = nextAttempts >= 3;
          
          await prisma.job.update({
            where: { id: job.id },
            data: {
              jdBatchId: null,
              scoreAttempts: { increment: 1 },
              scoringStatus: isDead ? 'failed' : 'needs_jd',
              ...(isDead ? {
                scoreError: jobErr.message || 'Error executing search',
                fitCategory: 'rejected',
                passReason: 'Error calling Jina. Manual review required.'
              } : {})
            }
          });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Automatically trigger local heuristic scoring since it's fast and local
      try {
        await scoreJobs();
      } catch(e) {
        console.error('Failed to trigger scoreJobs automatically:', e);
      }
      
    })().catch(err => console.error('Background processing error:', err));

    return NextResponse.json({ message: 'JD Extraction started in background (Decoupled from Gemini)', count: queuedJobs.length });
  } catch (error: any) {
    console.error('JD Submit failed:', error);
    return NextResponse.json({ error: 'Failed to submit', details: error.message }, { status: 500 });
  }
}
