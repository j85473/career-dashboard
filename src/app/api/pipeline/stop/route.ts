import { NextResponse } from 'next/server';
import { updatePipelineState } from '@/lib/pipelineState';

export async function POST() {
  try {
    updatePipelineState({
      isRunning: false,
      currentStep: 'Stopping...',
      stepProgress: 'Pipeline manually stopped. Background loops will exit cleanly.'
    });
    return NextResponse.json({ message: 'Pipeline stop signal sent.' });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to stop pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
