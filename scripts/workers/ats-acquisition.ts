import type {
  AtsAcquisitionParentMessage,
  AtsAcquisitionWorkerMessage,
} from '../../src/lib/pipelineWorkerProcess';

const controller = new AbortController();
let stopReason: 'stop-requested' | 'parent-disconnect' | 'signal' = 'stop-requested';
let finishing = false;
let fatalReported = false;

function messageText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1500);
}

function send(message: AtsAcquisitionWorkerMessage): void {
  if (!process.connected) return;
  process.send?.(message, () => {
    // The parent may close IPC while the worker is finishing. The process
    // lifecycle, not delivery of this final diagnostic, controls shutdown.
  });
}

type WorkerMessagePayload =
  | { type: 'ready' }
  | { type: 'progress'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'fatal'; message: string }
  | { type: 'stopped'; reason: 'stop-requested' | 'parent-disconnect' | 'signal' };

function workerMessage(message: WorkerMessagePayload): AtsAcquisitionWorkerMessage {
  return {
    ...message,
    role: 'ats-acquisition',
    pid: process.pid,
  } as AtsAcquisitionWorkerMessage;
}

function requestStop(reason: typeof stopReason, detail: string): void {
  stopReason = reason;
  if (!controller.signal.aborted) controller.abort(new Error(detail));
}

function reportFatal(error: unknown): void {
  if (fatalReported) return;
  fatalReported = true;
  process.exitCode = 1;
  send(workerMessage({ type: 'fatal', message: messageText(error) }));
  requestStop(stopReason, messageText(error));
}

process.on('message', (message: AtsAcquisitionParentMessage) => {
  if (message?.type === 'stop') requestStop('stop-requested', message.reason);
});
process.once('disconnect', () => {
  if (!finishing) requestStop('parent-disconnect', 'Parent IPC disconnected.');
});
process.once('SIGTERM', () => requestStop('signal', 'SIGTERM'));
process.once('SIGINT', () => requestStop('signal', 'SIGINT'));
process.once('uncaughtException', reportFatal);
process.once('unhandledRejection', reportFatal);

async function main(): Promise<void> {
  if (process.env.PIPELINE_WORKER_ROLE !== 'ats-acquisition') {
    throw new Error('ATS acquisition worker role was not configured by its parent.');
  }

  const [loopModule, pipelineStateModule, prismaModule, controlPrismaModule] = await Promise.all([
    import('../../src/lib/atsAcquisitionLoop'),
    import('../../src/lib/pipelineState'),
    import('../../src/lib/prisma'),
    import('../../src/lib/controlPrisma'),
  ]);
  send(workerMessage({ type: 'ready' }));
  try {
    const result = await loopModule.runAtsAcquisitionLoop({
      signal: controller.signal,
      shouldStop: pipelineStateModule.pipelineStopRequested,
      onProgress: (message) => send(workerMessage({ type: 'progress', message })),
    });
    if (!fatalReported) {
      send(workerMessage({ type: 'stopped', reason: result.reason === 'stop-requested' ? stopReason : result.reason }));
    }
  } finally {
    finishing = true;
    await Promise.allSettled([
      prismaModule.prisma.$disconnect(),
      controlPrismaModule.controlPrisma.$disconnect(),
    ]);
    if (process.connected) process.disconnect();
  }
}

main().catch((error) => {
  reportFatal(error);
  finishing = true;
  if (process.connected) process.disconnect();
});
