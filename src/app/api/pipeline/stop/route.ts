import { NextResponse } from 'next/server';
import { abortActivePipeline, updatePipelineState } from '@/lib/pipelineState';
import { prisma } from '@/lib/prisma';

export async function POST() {
  try {
    updatePipelineState({
      isRunning: false,
      currentStep: 'Stopping...',
      stepProgress: 'Pipeline manually stopped. Background loops will exit cleanly.'
    });
    // The loop consults the shared row, which may be on another host, so this
    // write is awaited rather than left to the fire-and-forget mirror. The lock
    // is left alone: its owner releases it as the run unwinds.
    await prisma.pipelineState.upsert({
      where: { id: 'global' },
      update: { isRunning: false, currentStep: 'Stopping...', stepProgress: 'Pipeline manually stopped. Background loops will exit cleanly.', lastUpdated: new Date() },
      create: { id: 'global', isRunning: false, currentStep: 'Stopping...', stepProgress: 'Pipeline manually stopped. Background loops will exit cleanly.' },
    });
    const abortedLocally = abortActivePipeline('Pipeline stop requested by the stop endpoint.');
    return NextResponse.json({ message: 'Pipeline stop signal sent.', abortedLocally });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to stop pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
