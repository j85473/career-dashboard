import { NextResponse } from 'next/server';
import { abortActivePipeline, updatePipelineState } from '@/lib/pipelineState';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    const mode = new URL(request.url).searchParams.get('mode');
    if (mode !== null && mode !== 'quiesce') {
      return NextResponse.json({ error: 'Unknown pipeline stop mode.' }, { status: 400 });
    }
    const pauseSchedule = mode !== 'quiesce';
    const currentStep = pauseSchedule ? 'Pausing...' : 'Stopping...';
    const stepProgress = pauseSchedule
      ? 'Pipeline manually stopped. Scheduled runs remain paused until manually resumed.'
      : 'Pipeline is quiescing for deployment. Background loops will exit cleanly.';
    updatePipelineState({
      isRunning: false,
      currentStep,
      stepProgress,
    });
    // The loop consults the shared row, which may be on another host, so this
    // write is awaited rather than left to the fire-and-forget mirror. The lock
    // is left alone: its owner releases it as the run unwinds.
    await prisma.pipelineState.upsert({
      where: { id: 'global' },
      update: { isRunning: false, schedulePaused: pauseSchedule, currentStep, stepProgress, lastUpdated: new Date() },
      create: { id: 'global', isRunning: false, schedulePaused: pauseSchedule, currentStep, stepProgress },
    });
    const abortedLocally = abortActivePipeline(
      pauseSchedule
        ? 'Pipeline paused by the stop endpoint.'
        : 'Pipeline quiescence requested by deployment.',
    );
    return NextResponse.json({
      message: pauseSchedule ? 'Pipeline pause signal sent.' : 'Pipeline quiescence signal sent.',
      abortedLocally,
      schedulePaused: pauseSchedule,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to stop pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
