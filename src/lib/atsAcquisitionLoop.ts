import type { Prisma } from '@prisma/client';

import {
  claimDueIngestionTask,
  checkpointIngestionTask,
  completeIngestionTask,
  type IngestionTaskCompletionStatus,
} from './ingestionControl';
import {
  ATS_ACQUISITION_TASK_DEFINITION,
  ATS_ACTIVE_LOOP_DELAY_MS,
  ATS_BOARD_BATCH_SIZE,
  ATS_IDLE_LOOP_DELAY_MS,
} from './ingestionTaskCatalog';
import {
  ATS_ACQUISITION_CONCURRENCY,
  ATS_ACQUISITION_QUEUE_LIMIT,
  acquireAtsBoardBatch,
  atsQueueDepth,
  selectDueAtsBoards,
  type AtsAcquisitionResult,
} from './atsAcquisition';

export type AtsAcquisitionTurnPhase = 'finished' | 'partial' | 'failed' | 'interrupted';

export type AtsAcquisitionTurnClassification = {
  taskStatus: IngestionTaskCompletionStatus;
  phase: AtsAcquisitionTurnPhase;
  attempted: number;
  responded: number;
  synchronized: number;
  partial: number;
  deferred: number;
  interrupted: number;
  providerErrors: number;
  requests: number;
  error: string | null;
};

/**
 * Convert board receipts into one honest scheduler outcome. A turn is only a
 * success when every selected board finished its acquisition. A mixed result
 * is partial, an all-error turn is failed, and stop always wins so a truncated
 * turn can never advance the task watermark.
 */
export function classifyAtsAcquisitionTurn(input: {
  selectedCount: number;
  results: readonly AtsAcquisitionResult[];
  stopRequested?: boolean;
}): AtsAcquisitionTurnClassification {
  const attempted = input.results.filter((result) => result.requestCount > 0).length;
  const responded = input.results.filter((result) => result.responded).length;
  const synchronized = input.results.filter((result) => result.outcome === 'synchronized').length;
  const partial = input.results.filter((result) => result.outcome === 'partial').length;
  const deferred = input.results.filter((result) => result.outcome === 'deferred').length;
  const interrupted = input.results.filter((result) => result.outcome === 'interrupted').length;
  const requestFailures = input.results.filter((result) => (
    result.outcome === 'timeout'
    || result.outcome === 'throttled'
    || result.outcome === 'error'
  )).length;
  const requests = input.results.reduce((sum, result) => sum + result.requestCount, 0);
  const unprocessed = Math.max(0, input.selectedCount - input.results.length);
  const wasInterrupted = Boolean(input.stopRequested || interrupted > 0);
  const noUsableResult = input.selectedCount > 0
    && input.results.length > 0
    && synchronized === 0
    && partial === 0
    && deferred === 0
    && interrupted === 0;
  const missingWithoutStop = unprocessed > 0 && !wasInterrupted;
  const providerErrors = requestFailures + (missingWithoutStop && requestFailures === 0 ? 1 : 0);

  if (wasInterrupted) {
    return {
      taskStatus: 'partial',
      phase: 'interrupted',
      attempted,
      responded,
      synchronized,
      partial,
      deferred,
      interrupted: interrupted + unprocessed,
      providerErrors,
      requests,
      error: `ATS acquisition interrupted after ${input.results.length} of ${input.selectedCount} board(s).`,
    };
  }

  const missingWithoutProgress = missingWithoutStop
    && synchronized === 0
    && partial === 0
    && deferred === 0;
  if (noUsableResult || missingWithoutProgress) {
    return {
      taskStatus: 'failed',
      phase: 'failed',
      attempted,
      responded,
      synchronized,
      partial,
      deferred,
      interrupted,
      providerErrors: Math.max(1, providerErrors),
      requests,
      error: `ATS acquisition failed for ${Math.max(requestFailures, unprocessed)} board(s).`,
    };
  }

  if (partial > 0 || deferred > 0 || requestFailures > 0 || missingWithoutStop) {
    return {
      taskStatus: 'partial',
      phase: 'partial',
      attempted,
      responded,
      synchronized,
      partial,
      deferred,
      interrupted,
      providerErrors,
      requests,
      error: [
        partial ? `${partial} pagination continuation(s)` : null,
        deferred ? `${deferred} provider deferral(s)` : null,
        requestFailures ? `${requestFailures} request failure(s)` : null,
        missingWithoutStop ? `${unprocessed} board(s) not processed` : null,
      ].filter(Boolean).join(', '),
    };
  }

  return {
    taskStatus: 'succeeded',
    phase: 'finished',
    attempted,
    responded,
    synchronized,
    partial,
    deferred,
    interrupted,
    providerErrors,
    requests,
    error: null,
  };
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export type AtsAcquisitionLoopOptions = {
  signal: AbortSignal;
  shouldStop: () => Promise<boolean>;
  onProgress?: (message: string) => void;
};

export type AtsAcquisitionLoopResult = {
  reason: 'stop-requested';
};

const EMPTY_COUNTERS = {
  seen: 0,
  inserted: 0,
  duplicates: 0,
  filtered: 0,
  processingErrors: 0,
} as const;

// The scheduler lease is thirty minutes, but detail-enrichment turns can now
// legitimately run longer than listing-only turns. Renew well inside that
// bound so cleanup or a replacement worker cannot reclaim live child work.
export const ATS_ACQUISITION_TASK_HEARTBEAT_MS = 60_000;

export function atsAcquisitionCheckpoint(input: {
  selectedCount: number;
  results: readonly AtsAcquisitionResult[];
}): {
  counters: typeof EMPTY_COUNTERS & { providerErrors: number; requests: number };
  cursor: Prisma.InputJsonObject;
} {
  const providerErrors = input.results.filter((result) => (
    result.outcome === 'timeout'
    || result.outcome === 'throttled'
    || result.outcome === 'error'
  )).length;
  return {
    counters: {
      ...EMPTY_COUNTERS,
      providerErrors,
      requests: input.results.reduce((sum, result) => sum + result.requestCount, 0),
    },
    cursor: {
      phase: 'running',
      selected: input.selectedCount,
      completed: input.results.length,
      synchronized: input.results.filter((result) => result.outcome === 'synchronized').length,
      partial: input.results.filter((result) => result.outcome === 'partial').length,
      deferred: input.results.filter((result) => result.outcome === 'deferred').length,
      providerErrors,
    },
  };
}

export async function runAtsAcquisitionLoop(
  options: AtsAcquisitionLoopOptions,
): Promise<AtsAcquisitionLoopResult> {
  const stopped = async () => options.signal.aborted || await options.shouldStop();
  const progress = (message: string) => options.onProgress?.(message);

  while (!await stopped()) {
    const queuedBefore = await atsQueueDepth();
    if (queuedBefore >= ATS_ACQUISITION_QUEUE_LIMIT) {
      progress(`Backpressure (${queuedBefore}/${ATS_ACQUISITION_QUEUE_LIMIT} batches queued)`);
      await waitForDelay(ATS_ACTIVE_LOOP_DELAY_MS, options.signal);
      continue;
    }

    const claim = await claimDueIngestionTask(ATS_ACQUISITION_TASK_DEFINITION.spec);
    if (!claim) {
      progress('Waiting for the next board turn...');
      await waitForDelay(ATS_ACTIVE_LOOP_DELAY_MS, options.signal);
      continue;
    }

    try {
      if (await stopped()) {
        const retained = await completeIngestionTask({
          taskId: claim.task.id,
          taskKey: claim.task.taskKey,
          leaseToken: claim.leaseToken,
          status: 'partial',
          counters: { ...EMPTY_COUNTERS, providerErrors: 0, requests: 0 },
          cadenceMs: ATS_ACQUISITION_TASK_DEFINITION.intervalMs,
          continuationDelayMs: ATS_ACTIVE_LOOP_DELAY_MS,
          cursor: { phase: 'interrupted', selected: 0, completed: 0 },
          error: 'ATS acquisition interrupted before board selection.',
        });
        if (!retained) throw new Error('ATS acquisition task lost its lease while stopping.');
        break;
      }

      const capacity = Math.max(1, ATS_ACQUISITION_QUEUE_LIMIT - queuedBefore);
      const selectionLimit = Math.min(ATS_BOARD_BATCH_SIZE, capacity);
      const boards = await selectDueAtsBoards(selectionLimit);
      if (boards.length === 0) {
        const retained = await completeIngestionTask({
          taskId: claim.task.id,
          taskKey: claim.task.taskKey,
          leaseToken: claim.leaseToken,
          status: 'succeeded',
          counters: { ...EMPTY_COUNTERS, providerErrors: 0, requests: 0 },
          cadenceMs: ATS_ACQUISITION_TASK_DEFINITION.intervalMs,
          watermarkAt: new Date(),
          cursor: { phase: 'idle', queueDepth: queuedBefore },
        });
        if (!retained) throw new Error('ATS acquisition task lost its lease during idle completion.');
        progress('No due boards; checking again shortly...');
        await waitForDelay(ATS_IDLE_LOOP_DELAY_MS, options.signal);
        continue;
      }

      progress(`Contacting ${boards.length} due boards...`);
      const queue = [...boards];
      const results: AtsAcquisitionResult[] = [];
      const workerCount = Math.min(ATS_ACQUISITION_CONCURRENCY, queue.length);
      const turnController = new AbortController();
      const turnSignal = AbortSignal.any([options.signal, turnController.signal]);
      let fatalWorkerError: unknown = null;
      let heartbeatInFlight: Promise<void> | null = null;
      const heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || turnSignal.aborted) return;
        const checkpoint = atsAcquisitionCheckpoint({ selectedCount: boards.length, results });
        heartbeatInFlight = checkpointIngestionTask({
          taskId: claim.task.id,
          leaseToken: claim.leaseToken,
          counters: checkpoint.counters,
          cursor: checkpoint.cursor,
        }).then((retained) => {
          if (retained) return;
          const error = new Error('ATS acquisition task lost its scheduler lease during a live turn.');
          fatalWorkerError ||= error;
          if (!turnController.signal.aborted) turnController.abort(error);
        }).catch((error) => {
          fatalWorkerError ||= error;
          if (!turnController.signal.aborted) turnController.abort(error);
        }).finally(() => {
          heartbeatInFlight = null;
        });
      }, ATS_ACQUISITION_TASK_HEARTBEAT_MS);
      const workers = Array.from({ length: workerCount }, async () => {
        try {
          while (queue.length > 0 && !turnSignal.aborted && !await stopped()) {
            const board = queue.shift();
            if (!board) return;
            progress(`${board.platform}:${board.slug}`);
            results.push(await acquireAtsBoardBatch(board, turnSignal));
          }
        } catch (error) {
          fatalWorkerError ||= error;
          if (!turnController.signal.aborted) turnController.abort(error);
        }
      });
      // Promise.all rejects on the first worker and would let sibling provider
      // calls outlive the scheduler receipt (and even Prisma disconnect in the
      // child). Contain the first fatal error, abort siblings, and join every
      // started worker before classifying or returning control to the parent.
      await Promise.allSettled(workers);
      clearInterval(heartbeatTimer);
      const pendingHeartbeat = heartbeatInFlight;
      if (pendingHeartbeat) await pendingHeartbeat;
      if (fatalWorkerError) throw fatalWorkerError;

      const stopRequested = await stopped();
      const outcome = classifyAtsAcquisitionTurn({
        selectedCount: boards.length,
        results,
        stopRequested,
      });
      const queueAfter = await atsQueueDepth();
      const retained = await completeIngestionTask({
        taskId: claim.task.id,
        taskKey: claim.task.taskKey,
        leaseToken: claim.leaseToken,
        status: outcome.taskStatus,
        counters: {
          ...EMPTY_COUNTERS,
          providerErrors: outcome.providerErrors,
          requests: outcome.requests,
        },
        cadenceMs: ATS_ACQUISITION_TASK_DEFINITION.intervalMs,
        continuationDelayMs: outcome.taskStatus === 'succeeded'
          && boards.length < selectionLimit
          ? null
          : ATS_ACTIVE_LOOP_DELAY_MS,
        watermarkAt: outcome.taskStatus === 'succeeded' ? new Date() : null,
        cursor: {
          phase: outcome.phase,
          selected: boards.length,
          attempted: outcome.attempted,
          responded: outcome.responded,
          synchronized: outcome.synchronized,
          partial: outcome.partial,
          deferred: outcome.deferred,
          interrupted: outcome.interrupted,
          queueDepth: queueAfter,
        } satisfies Prisma.InputJsonObject,
        error: outcome.error,
      });
      if (!retained) throw new Error('ATS acquisition task lost its lease during completion.');
      progress(
        `${outcome.phase}: ${outcome.attempted} attempted · ${outcome.responded} responded · ${outcome.synchronized} synchronized`,
      );
      if (stopRequested) break;
    } catch (error) {
      const stopRequested = await stopped().catch(() => options.signal.aborted);
      const message = error instanceof Error ? error.message : String(error);
      const retained = await completeIngestionTask({
        taskId: claim.task.id,
        taskKey: claim.task.taskKey,
        leaseToken: claim.leaseToken,
        status: stopRequested ? 'partial' : 'failed',
        counters: {
          ...EMPTY_COUNTERS,
          providerErrors: stopRequested ? 0 : 1,
          requests: 0,
        },
        cadenceMs: ATS_ACQUISITION_TASK_DEFINITION.intervalMs,
        continuationDelayMs: ATS_ACTIVE_LOOP_DELAY_MS,
        cursor: { phase: stopRequested ? 'interrupted' : 'failed' },
        error: message.slice(0, 1000),
      }).catch(() => false);
      if (stopRequested && retained) break;
      throw error;
    }

    await waitForDelay(ATS_ACTIVE_LOOP_DELAY_MS, options.signal);
  }

  return { reason: 'stop-requested' };
}
