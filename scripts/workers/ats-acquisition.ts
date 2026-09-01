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
  | {
      type: 'backpressure';
      active: boolean;
      remainingJobs: number;
      highWatermark: number;
      lowWatermark: number;
      enrichmentJobs: number;
      listingJobs: number;
      compactionJobs: number;
      publicationJobs: number;
      terminalUnsealedJobs: number;
      sealedUnpublishedJobs: number;
      publishedUnpersistedJobs: number;
      admissionState: 'open' | 'draining';
      publicationPaused: boolean;
      legacyPersistenceJobs: number;
      v2PersistenceJobs: number;
      observedAt: string;
    }
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

  const [
    loopModule,
    pipelineStateModule,
    prismaModule,
    controlPrismaModule,
    compatibilityModule,
    dispatcherModule,
    coordinationModule,
    acquisitionModule,
    backlogTelemetryModule,
  ] = await Promise.all([
    import('../../src/lib/atsAcquisitionLoop'),
    import('../../src/lib/pipelineState'),
    import('../../src/lib/prisma'),
    import('../../src/lib/controlPrisma'),
    import('../../src/lib/atsAcquisitionCompatibility'),
    import('../../src/lib/atsAcquisitionDispatcherV2'),
    import('../../src/lib/atsAcquisitionCoordination'),
    import('../../src/lib/atsAcquisition'),
    import('../../src/lib/atsBacklogTelemetry'),
  ]);
  await compatibilityModule.assertAtsAcquisitionWriterCompatibility();
  let coordinationLeases: Awaited<ReturnType<typeof coordinationModule.claimAtsWorkerSlots>> = [];
  let coordinationHeartbeat: ReturnType<typeof setInterval> | null = null;
  let coordinationHeartbeatInFlight: Promise<void> | null = null;
  if (coordinationModule.ATS_DISTRIBUTED_WORKERS_ENABLED) {
    const gate = await coordinationModule.readAtsCoordinationGate();
    const baseValidation = coordinationModule.validateAtsCoordinationGate(gate);
    if (!baseValidation.valid) throw new Error(baseValidation.reason);
    const distributedValidation = coordinationModule.validateAtsCoordinationGate(
      gate,
      { requireDistributed: true },
    );
    if (!distributedValidation.valid) {
      send(workerMessage({
        type: 'warning',
        message: `Distributed ATS capacity remains dormant: ${distributedValidation.reason}`,
      }));
    } else {
      if (!gate) throw new Error('ATS coordination gate disappeared before local slot claim.');
      coordinationLeases = await coordinationModule.claimAtsWorkerSlots({
        workerKind: 'pi-acquisition',
        count: gate.localSlotReserve,
      });
      if (coordinationLeases.length !== gate.localSlotReserve) {
        await coordinationModule.releaseAtsWorkerSlots(coordinationLeases);
        throw new Error(
          `Pi acquisition worker claimed ${coordinationLeases.length} of ${gate.localSlotReserve} reserved global slots.`,
        );
      }
      coordinationHeartbeat = setInterval(() => {
        if (coordinationHeartbeatInFlight || controller.signal.aborted) return;
        coordinationHeartbeatInFlight = coordinationModule.heartbeatAtsWorkerSlots(coordinationLeases)
          .then((retained) => {
            if (!retained) reportFatal(new Error('Pi acquisition worker lost a global capacity lease.'));
          })
          .catch(reportFatal)
          .finally(() => { coordinationHeartbeatInFlight = null; });
      }, coordinationModule.ATS_WORKER_SLOT_HEARTBEAT_MS);
    }
  }
  let telemetryPressureActive = false;
  let telemetryFailureReported = false;
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;
  let telemetryInFlight: Promise<void> | null = null;
  const reportBacklogTelemetry = async () => {
    try {
      const snapshot = await backlogTelemetryModule.readAtsOperatorBacklogSnapshot();
      telemetryPressureActive = acquisitionModule.nextAtsBackpressureState({
        active: telemetryPressureActive,
        remainingJobs: snapshot.legacyPersistenceJobs,
      }).active;
      telemetryFailureReported = false;
      send(workerMessage({
        type: 'backpressure',
        active: telemetryPressureActive || snapshot.publicationPaused,
        remainingJobs: snapshot.persistenceJobs,
        highWatermark: acquisitionModule.ATS_ACQUISITION_JOB_HIGH_WATERMARK,
        lowWatermark: acquisitionModule.ATS_ACQUISITION_JOB_LOW_WATERMARK,
        enrichmentJobs: snapshot.enrichmentJobs,
        listingJobs: snapshot.listingJobs,
        compactionJobs: snapshot.compactionJobs,
        publicationJobs: snapshot.publicationJobs,
        terminalUnsealedJobs: snapshot.terminalUnsealedJobs,
        sealedUnpublishedJobs: snapshot.sealedUnpublishedJobs,
        publishedUnpersistedJobs: snapshot.publishedUnpersistedJobs,
        admissionState: snapshot.admissionState,
        publicationPaused: snapshot.publicationPaused,
        legacyPersistenceJobs: snapshot.legacyPersistenceJobs,
        v2PersistenceJobs: snapshot.v2PersistenceJobs,
        observedAt: snapshot.observedAt.toISOString(),
      }));
    } catch (error) {
      if (!telemetryFailureReported) {
        telemetryFailureReported = true;
        send(workerMessage({
          type: 'warning',
          message: `ATS backlog telemetry unavailable: ${messageText(error)}`,
        }));
      }
    }
  };
  const scheduleBacklogTelemetry = () => {
    if (telemetryInFlight || controller.signal.aborted) return;
    telemetryInFlight = reportBacklogTelemetry()
      .finally(() => { telemetryInFlight = null; });
  };
  let v2RuntimeAuthorized = false;
  if (dispatcherModule.ATS_ACQUISITION_V2_ENABLED) {
    try {
      await compatibilityModule.assertAtsV2AuthorityActive();
      v2RuntimeAuthorized = true;
    } catch (error) {
      send(workerMessage({
        type: 'warning',
        message: `ATS v2 remains paused: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }
  send(workerMessage({ type: 'ready' }));
  await reportBacklogTelemetry();
  telemetryTimer = setInterval(
    scheduleBacklogTelemetry,
    backlogTelemetryModule.ATS_BACKLOG_TELEMETRY_INTERVAL_MS,
  );
  try {
    const legacyLoop = loopModule.runAtsAcquisitionLoop({
      signal: controller.signal,
      shouldStop: pipelineStateModule.pipelineStopRequested,
      onProgress: (message) => send(workerMessage({ type: 'progress', message })),
    });
    const result = v2RuntimeAuthorized
      ? await Promise.all([
          legacyLoop,
          dispatcherModule.runAtsV2ContinuousDispatcher({
            signal: controller.signal,
            totalSlots: dispatcherModule.ATS_ACQUISITION_V2_SLOT_COUNT,
            plan: () => dispatcherModule.atsV2RuntimeLanePlan(
              dispatcherModule.ATS_ACQUISITION_V2_SLOT_COUNT,
            ),
            onProgress: ({ lane, claim }) => send(workerMessage({
              type: 'progress',
              message: `V2 ${lane}: ${claim.platform}:${claim.slug} · ${claim.workType}`,
            })),
            onError: ({ workerIndex, phase, error }) => send(workerMessage({
              type: 'progress',
              message: `V2 lane ${workerIndex + 1} ${phase} deferred: ${error instanceof Error ? error.message : String(error)}`,
            })),
          }),
          ...(dispatcherModule.ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED ? [
            dispatcherModule.runAtsV2ContinuousPublisher({
              signal: controller.signal,
              onProgress: ({ publishedSegments, publishedItems, remainingJobs }) => send(workerMessage({
                type: 'progress',
                message: `V2 publisher: ${publishedSegments} segment(s) · ${publishedItems} item(s) · ${remainingJobs} awaiting persistence`,
              })),
              onError: (error) => send(workerMessage({
                type: 'progress',
                message: `V2 publisher deferred: ${error instanceof Error ? error.message : String(error)}`,
              })),
            }),
          ] : []),
        ]).then(([legacyResult]) => legacyResult)
      : await legacyLoop;
    if (!fatalReported) {
      send(workerMessage({ type: 'stopped', reason: result.reason === 'stop-requested' ? stopReason : result.reason }));
    }
  } finally {
    finishing = true;
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (telemetryInFlight) await telemetryInFlight;
    if (coordinationHeartbeat) clearInterval(coordinationHeartbeat);
    if (coordinationHeartbeatInFlight) await coordinationHeartbeatInFlight;
    await coordinationModule.releaseAtsWorkerSlots(coordinationLeases).catch(() => undefined);
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
