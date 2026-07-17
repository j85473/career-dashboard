import { NextResponse } from 'next/server';
import { tryAcquirePipelineLock, updatePipelineState } from '@/lib/pipelineState';
import { prisma } from '@/lib/prisma';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const releaseLock = tryAcquirePipelineLock();
    if (!releaseLock) {
      return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'JD Extraction', stepProgress: 'Initializing extraction pipeline...' });
    } catch (error) {
      releaseLock();
      throw error;
    }

    // Run in background
    (async () => {
      try {
        let loopCount = 0;
        let initialNeedsJdCount = -1;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        while (true) {
          loopCount++;
          const needsJdCount = await prisma.job.count({ 
            where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { in: ['pending_af', 'inbox'] }, scoreAttempts: { lt: 3 } }
          });
          const processingJdCount = await prisma.job.count({
            where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { in: ['pending_af', 'inbox'] } }
          });

          const currentTotal = needsJdCount + processingJdCount;
          if (initialNeedsJdCount === -1 || currentTotal > initialNeedsJdCount) initialNeedsJdCount = currentTotal;
          const processed = initialNeedsJdCount - currentTotal;

          if (needsJdCount === 0 && processingJdCount === 0) {
            updatePipelineState({ stepProgress: `JD extraction complete. Processed ${processed} jobs.` });
            break;
          }

          if (needsJdCount > 0 && processingJdCount === 0) {
            updatePipelineState({ stepProgress: `[Processed: ${processed}] Pass ${loopCount}: Extracting JDs for ${needsJdCount} jobs...` });
            const req = new Request(`${appUrl}/api/jobs/batch-jd-submit`, { method: 'POST' });
            try {
              // Local fetch doesn't easily work without an absolute URL or proper setup in AppRouter,
              // but since we're in the same process, it's actually safer to just do a fetch to internal route
              // OR we can just import the route handler. Since POST from /batch-jd-submit expects a Request...
              const { POST: batchSubmitPost } = await import('@/app/api/jobs/batch-jd-submit/route');
              const res = await batchSubmitPost(req);
              if (!res.ok) {
                 console.error('Extraction batch returned non-ok status');
                 break;
              }
            } catch (err) {
              console.error('JD extraction error:', err);
              break; // Stop loop on hard error
            }
          } else if (processingJdCount > 0) {
            updatePipelineState({ stepProgress: `Pass ${loopCount}: Waiting for Jina to finish ${processingJdCount} jobs...` });
            await new Promise(r => setTimeout(r, 10000));
          }
        }

        updatePipelineState({
          isRunning: false,
          currentStep: 'Idle',
          stepProgress: `JD extraction loop finished.`,
        });
      } catch (error) {
        console.error('Extraction pipeline error:', error);
        updatePipelineState({
          isRunning: false,
          currentStep: 'Error',
          stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        releaseLock();
      }
    })();

    return NextResponse.json({ message: 'JD Extraction started in background' });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to start extraction pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
