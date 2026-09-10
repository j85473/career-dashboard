import {
  ATS_DISTRIBUTED_WORKERS_ENABLED,
  ATS_WORKER_SLOT_HEARTBEAT_MS,
  claimAtsWorkerSlots,
  heartbeatAtsWorkerSlots,
  readAtsCoordinationGate,
  releaseAtsWorkerSlots,
  validateAtsCoordinationGate,
} from '../../src/lib/atsAcquisitionCoordination';
import { assertAtsV2AuthorityActive } from '../../src/lib/atsAcquisitionCompatibility';
import {
  atsV2RuntimeLanePlan,
  promoteDrainedLegacyBoardsToV2,
  runAtsV2ContinuousDispatcher,
  type AtsV2LanePlan,
} from '../../src/lib/atsAcquisitionDispatcherV2';
import { pipelineStopRequested } from '../../src/lib/pipelineState';
import { prisma } from '../../src/lib/prisma';
import { controlPrisma } from '../../src/lib/controlPrisma';

/**
 * Aborted only by a process signal. A paused Pi pipeline must never reach this
 * controller: pausing is a temporary state the worker waits out, not a reason
 * to end the process.
 */
const controller = new AbortController();
// Release B lets one Mac worker hold every global lane, so the clamp follows
// the gate's 8-slot ceiling instead of the 4 lanes Release A left for the Pi.
const requestedSlots = Math.max(1, Math.min(
  8,
  Number.parseInt(process.env.ATS_REMOTE_WORKER_SLOTS || '1', 10) || 1,
));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort(new Error(signal)));
}

function wait(milliseconds: number): Promise<void> {
  if (controller.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Release A confined the Mac to continuation lanes because the Pi still owned
 * coverage. Under Release B the Mac owns every ATS acquisition lane, so it
 * plans coverage and continuation with the same balanced planner the Pi used.
 * Set ATS_REMOTE_WORKER_CONTINUATION_ONLY=true to pin the old behaviour while
 * both hosts are still running lanes during the cutover.
 */
const CONTINUATION_ONLY = ['1', 'true'].includes(
  String(process.env.ATS_REMOTE_WORKER_CONTINUATION_ONLY || '').trim().toLowerCase(),
);

function continuationPlan(slots: number): AtsV2LanePlan {
  return {
    totalSlots: slots,
    coverageSlots: 0,
    continuationSlots: slots,
    requiredByNow: 0,
    coverageDebt: 0,
    projectedContacts: 0,
    reason: 'remote_continuation_only',
  };
}

async function remotePlan(slots: number): Promise<AtsV2LanePlan> {
  if (CONTINUATION_ONLY) return continuationPlan(slots);
  return atsV2RuntimeLanePlan(slots);
}

/**
 * How often drained legacy boards are handed to the v2 engine.
 *
 * The transfer used to run once per pass of the Pi's in-process acquisition
 * loop, which iterated every few seconds. This worker has no such pass: one
 * dispatch session runs for hours, so a call at session start alone would let
 * newly discovered boards wait until the next restart. Board discovery creates
 * rows without an engine, so they default to legacy and the v2 dispatcher --
 * which filters on the engine -- cannot see them at all. Left unwired, that is
 * not a delay but a permanent hole: on 2026-09-10 it held 2,357 active boards
 * that had never once been contacted, each still counted against weekly
 * coverage.
 *
 * Five minutes rather than the heartbeat's thirty seconds because nothing here
 * is urgent -- a board drains on its own schedule -- and the scan, though fully
 * index-driven at about 30ms, has no reason to run 120 times an hour.
 */
const LEGACY_PROMOTION_INTERVAL_MS = 5 * 60_000;

/**
 * Best-effort on purpose. This transfer only changes which engine owns a board;
 * it does not touch status, schedule, history, or any acquired work, and the
 * dispatcher's own filters remain the fence. A transfer that cannot be written
 * this minute is simply retried next interval, and must never take down a
 * dispatch session that is otherwise sweeping normally.
 */
async function promoteDrainedLegacyBoards(): Promise<void> {
  try {
    const promoted = await promoteDrainedLegacyBoardsToV2();
    if (promoted.count > 0) {
      console.log(`ATS remote worker transferred ${promoted.count.toLocaleString('en-US')} drained board(s) to v2.`);
    }
  } catch (error) {
    console.error(
      `ATS remote worker could not transfer drained legacy boards: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runLeasedDispatcher(): Promise<void> {
  const leases = await claimAtsWorkerSlots({
    workerKind: 'mac-continuation',
    count: requestedSlots,
  });
  if (leases.length === 0) {
    console.log('ATS remote continuation worker is waiting for an enabled global slot.');
    await wait(5_000);
    return;
  }

  const leaseController = new AbortController();
  const signal = AbortSignal.any([controller.signal, leaseController.signal]);
  // A pause ends this dispatch session and releases its lanes, then main()
  // waits for the pipeline to resume. It must not end the process.
  const stopPoll = setInterval(() => {
    void pipelineStopRequested().then((stopped) => {
      if (stopped && !leaseController.signal.aborted) {
        leaseController.abort(new Error('The authoritative Pi pipeline is paused.'));
      }
    }).catch(() => { /* a transient read must not drop the lanes */ });
  }, 5_000);
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || signal.aborted) return;
    heartbeatInFlight = heartbeatAtsWorkerSlots(leases)
      .then((retained) => {
        if (!retained && !leaseController.signal.aborted) {
          leaseController.abort(new Error('Remote continuation worker lost its global capacity lease.'));
        }
      })
      .catch((error) => {
        if (!leaseController.signal.aborted) leaseController.abort(error);
      })
      .finally(() => { heartbeatInFlight = null; });
  }, ATS_WORKER_SLOT_HEARTBEAT_MS);
  let promotionInFlight: Promise<void> | null = null;
  const promotion = setInterval(() => {
    if (promotionInFlight || signal.aborted) return;
    promotionInFlight = promoteDrainedLegacyBoards()
      .finally(() => { promotionInFlight = null; });
  }, LEGACY_PROMOTION_INTERVAL_MS);

  try {
    console.log(`ATS remote worker claimed ${leases.length} global slot(s) (${CONTINUATION_ONLY ? 'continuation-only' : 'balanced'}).`);
    await promoteDrainedLegacyBoards();
    await runAtsV2ContinuousDispatcher({
      signal,
      totalSlots: leases.length,
      lanePolicy: CONTINUATION_ONLY ? 'continuation-only' : 'balanced',
      plan: async () => remotePlan(leases.length),
      onProgress: ({ claim }) => {
        console.log(`ATS remote ${claim.platform}:${claim.slug} · ${claim.workType}`);
      },
      onError: ({ workerIndex, phase, error }) => {
        console.error(
          `ATS remote lane ${workerIndex + 1} ${phase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  } finally {
    clearInterval(stopPoll);
    clearInterval(heartbeat);
    clearInterval(promotion);
    if (heartbeatInFlight) await heartbeatInFlight;
    if (promotionInFlight) await promotionInFlight;
    await releaseAtsWorkerSlots(leases);
  }
}

async function main(): Promise<void> {
  if (!ATS_DISTRIBUTED_WORKERS_ENABLED) {
    throw new Error('ATS_DISTRIBUTED_WORKERS_ENABLED must be true for the remote continuation worker.');
  }
  await assertAtsV2AuthorityActive();
  const gate = await readAtsCoordinationGate();
  const validation = validateAtsCoordinationGate(gate, {
    requireDistributed: true,
    requireRemote: true,
  });
  if (!validation.valid) throw new Error(validation.reason);

  // Every Pi deployment stops the pipeline service, and the operator's Stop
  // button does the same. Treating either as terminal used to end this process
  // with status 0, which KeepAlive{SuccessfulExit:false} reads as "job done",
  // so acquisition stayed dead until the next login. Wait the pause out.
  let announcedPause = false;
  while (!controller.signal.aborted) {
    if (await pipelineStopRequested()) {
      if (!announcedPause) {
        announcedPause = true;
        console.log('ATS remote worker is paused: the Pi pipeline is not running.');
      }
      await wait(5_000);
      continue;
    }
    if (announcedPause) {
      announcedPause = false;
      console.log('ATS remote worker resuming: the Pi pipeline is running again.');
    }
    await runLeasedDispatcher();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([prisma.$disconnect(), controlPrisma.$disconnect()]);
  });
