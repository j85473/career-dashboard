import { NextResponse } from 'next/server';
import { markTimedOutPipeline } from '@/lib/pipelineState';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const dbState = await prisma.pipelineState.findUnique({ where: { id: 'global' } });
    if (dbState) {
      const state = {
        isRunning: dbState.isRunning,
        currentStep: dbState.currentStep,
        stepProgress: dbState.stepProgress,
        lastUpdated: dbState.lastUpdated.getTime(),
      };
      const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
      if (state.isRunning && Date.now() - state.lastUpdated > LOCK_TIMEOUT_MS) {
        state.isRunning = false;
        state.currentStep = 'Error';
        state.stepProgress = 'Pipeline timed out or crashed.';
      }
      return NextResponse.json(state);
    }
    
    // Fallback to local file if DB is empty
    return NextResponse.json(markTimedOutPipeline());
  } catch (error) {
    return NextResponse.json(
      { isRunning: false, currentStep: 'Error', stepProgress: 'Unable to read pipeline state.' },
      { status: 500 },
    );
  }
}
