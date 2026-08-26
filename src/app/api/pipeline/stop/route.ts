import { NextResponse } from 'next/server';
import { controlPrisma } from '@/lib/controlPrisma';
import { abortActivePipeline, PIPELINE_PAUSE_DEFAULT_MS, updatePipelineState } from '@/lib/pipelineState';

type StopMode = 'pause' | 'quiesce' | 'indefinite';

export async function POST(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get('mode');
    if (requested !== null && requested !== 'quiesce' && requested !== 'indefinite') {
      return NextResponse.json({ error: 'Unknown pipeline stop mode.' }, { status: 400 });
    }
    const mode: StopMode = requested === null ? 'pause' : requested;

    // Every mode stops immediately and stays stopped. They differ only in what
    // is allowed to start it again: a deployment quiesce leaves the schedule
    // enabled, an ordinary Stop holds it for a bounded window, and an explicit
    // indefinite Stop holds it until someone resumes by hand.
    const pauseSchedule = mode !== 'quiesce';
    const pausedUntil = mode === 'pause'
      ? new Date(Date.now() + PIPELINE_PAUSE_DEFAULT_MS)
      : null;

    const currentStep = pauseSchedule ? 'Pausing...' : 'Stopping...';
    const stepProgress = mode === 'quiesce'
      ? 'Pipeline is quiescing for deployment. Background loops will exit cleanly.'
      : mode === 'indefinite'
        ? 'Pipeline manually stopped. Scheduled runs remain paused until manually resumed.'
        : `Pipeline manually stopped. Scheduled runs resume automatically at ${pausedUntil?.toISOString()} unless resumed sooner.`;

    updatePipelineState({ isRunning: false, currentStep, stepProgress });
    // The loop consults the shared row, which may be on another host, so this
    // write is awaited rather than left to the fire-and-forget mirror. The lock
    // is left alone: its owner releases it as the run unwinds.
    await controlPrisma.pipelineState.upsert({
      where: { id: 'global' },
      update: { isRunning: false, schedulePaused: pauseSchedule, pausedUntil, currentStep, stepProgress, lastUpdated: new Date() },
      create: { id: 'global', isRunning: false, schedulePaused: pauseSchedule, pausedUntil, currentStep, stepProgress },
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
      pausedUntil: pausedUntil?.toISOString() ?? null,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to stop pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
