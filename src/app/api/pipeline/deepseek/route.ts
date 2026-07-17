import { NextResponse } from 'next/server';
import { runDeepseekEvaluation } from '@/lib/deepseekEvaluator';
import { tryAcquirePipelineLock, updatePipelineState } from '@/lib/pipelineState';
import { shouldContinueDeepseekEvaluation } from '@/lib/scoringState';

async function orchestrateDeepseek(releaseLock: () => void) {
  try {
    updatePipelineState({ isRunning: true, currentStep: 'AI Evaluation', stepProgress: 'Running DeepSeek A/E scoring...' });
    
    let failureMessage: string | null = null;
    let totalProcessed = 0;
    while (true) {
       try {
         const res = await runDeepseekEvaluation((msg) => {
           updatePipelineState({ stepProgress: `[Processed: ${totalProcessed}] AI Evaluation: ${msg}` });
         });
         
         totalProcessed += res.scoresProcessed;
         
         if (!shouldContinueDeepseekEvaluation(res)) {
            break;
         }
       } catch (err: unknown) {
         console.error('DeepSeek Evaluation Error:', err);
         failureMessage = err instanceof Error ? err.message : String(err);
         break;
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

    updatePipelineState(failureMessage
      ? { isRunning: false, currentStep: 'Error', stepProgress: `AI Evaluation Error: ${failureMessage}` }
      : { isRunning: false, currentStep: 'Idle', stepProgress: 'DeepSeek evaluation complete.' });
  } catch (error) {
    console.error('Pipeline failed:', error);
    updatePipelineState({ isRunning: false, currentStep: 'Error', stepProgress: String(error) });
  } finally {
    releaseLock();
  }
}

export async function POST() {
  try {
    const releaseLock = tryAcquirePipelineLock();
    if (!releaseLock) {
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing DeepSeek evaluation' });
    } catch (error) {
      releaseLock();
      throw error;
    }

    orchestrateDeepseek(releaseLock).catch(console.error);

    return NextResponse.json({ message: 'DeepSeek evaluation started in background' });
  } catch (error: unknown) {
    console.error('DeepSeek Evaluation API Error:', error);
    return NextResponse.json({ error: 'Failed to run DeepSeek evaluation', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
