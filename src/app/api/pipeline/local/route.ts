import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scoreJobs } from '@/lib/jobScoring';
import { tryAcquirePipelineLock, updatePipelineState } from '@/lib/pipelineState';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const releaseLock = tryAcquirePipelineLock();
    if (!releaseLock) {
      return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'Local Scoring', stepProgress: 'Initializing local scoring pipeline...' });
    } catch (error) {
      releaseLock();
      throw error;
    }

    // Run scoring in background
    (async () => {
      try {
        updatePipelineState({ stepProgress: 'Running local triage and heuristic scoring...' });
        const queuedCount = await prisma.job.count({ where: { scoringStatus: 'queued', jdBatchId: null, status: { in: ['pending_af', 'inbox'] } } });
        let totalScored = 0;
        for (let localPass = 0; localPass < 20; localPass++) {
          const processed = await scoreJobs((msg) => {
            if (!msg.startsWith('No new jobs') && !msg.startsWith('No resumes')) totalScored++;
            updatePipelineState({ stepProgress: `[Processed: ${totalScored}/${queuedCount}] ${msg}` });
          });
          if (processed === 0) break;
        }
        updatePipelineState({
          isRunning: false,
          currentStep: 'Idle',
          stepProgress: `Local scoring complete. Processed ${totalScored} jobs.`,
        });
      } catch (error) {
        console.error('Local Scoring error:', error);
        updatePipelineState({
          isRunning: false,
          currentStep: 'Error',
          stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        releaseLock();
      }
    })();

    return NextResponse.json({ message: 'Local Scoring started in background' });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to start local scoring', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
