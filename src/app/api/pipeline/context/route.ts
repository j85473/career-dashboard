import { NextResponse } from 'next/server';
import { runDeepseekEvaluation } from '@/lib/deepseekEvaluator';
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
      updatePipelineState({ isRunning: true, currentStep: 'Context Evaluation', stepProgress: 'Initializing context batch...' });
    } catch (error) {
      releaseLock();
      throw error;
    }

    // Run context batch in background
    (async () => {
      try {
        let totalScored = 0;
        let totalContext = 0;
        for (let pass = 0; pass < 20; pass++) {
          const res = await runDeepseekEvaluation((msg) => {
            updatePipelineState({ stepProgress: msg });
          });
          totalScored += res.scoresProcessed;
          totalContext += res.contextJobsProcessed;
          if (res.scoresProcessed === 0 && res.contextJobsProcessed === 0) break;
        }

        updatePipelineState({
          isRunning: false,
          currentStep: 'Idle',
          stepProgress: `Context loop complete. Processed ${totalContext} context updates and ${totalScored} job scores.`,
        });
      } catch (error) {
        console.error('Context pipeline error:', error);
        updatePipelineState({
          isRunning: false,
          currentStep: 'Error',
          stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        releaseLock();
      }
    })();

    return NextResponse.json({ message: 'Context evaluation started in background' });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to start context evaluation', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
