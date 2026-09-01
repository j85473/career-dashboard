import { Prisma, type AtsCompany } from '@prisma/client';

import {
  atsListingPageSize,
  fetchAtsBoardPage,
  isAtsProviderWideError,
  orderAtsCoverageCandidates,
  type AtsBoardForAcquisition,
} from './atsAcquisition';
import {
  ATS_LEDGER_DETAIL_REQUEST_BUDGET,
  ATS_LEDGER_LISTING_PAGE_BUDGET,
  ATS_LEDGER_QUANTUM_SOFT_MS,
  admitAtsV2Board,
  atsV2StagingSnapshot,
  claimNextAtsV2Continuation,
  commitAtsV2ListingPage,
  confirmAtsV2ListingContact,
  enrichNextAtsV2DetailItem,
  finishAtsV2Claim,
  materializeAtsV2PageObservations,
  publishReadyAtsV2Segments,
  reconcileExpiredAtsV2Work,
  recordAtsV2ListingDispatchIntent,
  resolveNextAtsV2ObservationChunk,
  sealReadyAtsV2Segments,
  terminalizeAtsV2NoNetworkItems,
  type AtsLedgerClaim,
} from './atsAcquisitionLedger';
import {
  ATS_ACQUISITION_CONCURRENCY,
  ATS_ACQUISITION_JOB_HIGH_WATERMARK,
  ATS_ACQUISITION_JOB_LOW_WATERMARK,
} from './atsAcquisition';
import { ATS_DAILY_BOARD_TARGET, ATS_RECOVERY_STATUSES, ATS_ROTATION_STATUSES, rotationDayFor } from './atsRotation';
import { assertAtsV2AuthorityActive } from './atsAcquisitionCompatibility';
import { prisma } from './prisma';
import { recordProviderFailure, recordProviderSuccess } from './ingestionControl';
import {
  atsDistributedArchitectureActive,
  atsNewBoardAdmissionsAllowed,
} from './atsAcquisitionCoordination';

function enabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export const ATS_ACQUISITION_V2_ENABLED = enabled(process.env.ATS_ACQUISITION_LEDGER_V2_ENABLED);
export const ATS_ACQUISITION_V2_SHADOW_ENABLED = enabled(process.env.ATS_ACQUISITION_LEDGER_SHADOW_ENABLED);
export const ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED = enabled(
  process.env.ATS_ACQUISITION_SEGMENT_PUBLICATION_ENABLED,
);
export const ATS_ACQUISITION_V2_SLOT_COUNT = Math.max(1, Math.min(
  ATS_ACQUISITION_CONCURRENCY,
  Number.parseInt(process.env.ATS_ACQUISITION_LEDGER_V2_SLOTS || '2', 10) || 2,
));

/**
 * Coverage is the only v2 lane that *adds* staging pressure: it admits new
 * boards and pulls fresh listing pages. Whenever there is enough already
 * acquired work to keep the lane busy, coverage is held to a single slot so
 * the engine drains before it ingests -- the same rule the continuation claim
 * ordering applies one level down.
 */
export const ATS_V2_COVERAGE_SLOTS_WHILE_DRAINING = 1;
// Each published segment also updates its batch row, which costs seconds under
// contention. Ten per transaction cannot commit inside the ledger timeout, so
// the publisher rolled back every pass and the sealed backlog never drained.
// Smaller passes commit steadily; total throughput is higher because the work
// is no longer discarded.
export const ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION = Math.max(1, Math.min(
  10,
  Number.parseInt(process.env.ATS_V2_PUBLICATION_MAX_SEGMENTS || '', 10) || 3,
));

const LEGACY_DRAIN_BATCH_STATUSES = [
  'fetching',
  'partial',
  'synchronized',
  'queued',
  'processing',
] as const;

/**
 * Transfer only boards whose legacy work is completely drained. Existing
 * payloads and claims retain legacy authority until they reach a terminal
 * state; the database attempt/write guards remain the final race fence.
 */
export async function promoteDrainedLegacyBoardsToV2(): Promise<{ count: number }> {
  await assertAtsV2AuthorityActive();
  return prisma.atsCompany.updateMany({
    where: {
      acquisitionEngine: 'legacy',
      status: { in: [...ATS_ROTATION_STATUSES, ...ATS_RECOVERY_STATUSES] },
      checkAttempts: { none: { outcome: 'running' } },
      ingestionBatches: {
        none: { status: { in: [...LEGACY_DRAIN_BATCH_STATUSES] } },
      },
    },
    data: { acquisitionEngine: 'v2' },
  });
}

export type AtsV2Lane = 'coverage' | 'continuation';

export type AtsV2LanePlan = {
  totalSlots: number;
  coverageSlots: number;
  continuationSlots: number;
  requiredByNow: number;
  coverageDebt: number;
  projectedContacts: number;
  reason: string;
};

export function planAtsV2LaneReservation(input: {
  totalSlots?: number;
  targetContacts?: number;
  confirmedContacts: number;
  elapsedDayFraction: number;
  coverageEligible: number;
  continuationEligible: number;
  observedCoverageQuantumMs?: number;
  remainingDayMs?: number;
}): AtsV2LanePlan {
  const totalSlots = Math.max(1, Math.min(
    ATS_ACQUISITION_CONCURRENCY,
    Math.floor(input.totalSlots || ATS_ACQUISITION_CONCURRENCY),
  ));
  const target = Math.max(0, Math.floor(input.targetContacts || ATS_DAILY_BOARD_TARGET));
  const elapsed = Math.max(0, Math.min(1, input.elapsedDayFraction));
  // Daily coverage is a finish-as-fast-as-safe target. Staging and persistence
  // backpressure below decide when new coverage must yield; the wall clock does
  // not deliberately stretch runnable work across the rest of the day.
  const requiredByNow = target;
  const coverageDebt = Math.max(0, requiredByNow - Math.max(0, input.confirmedContacts));
  const quantumMs = Math.max(1, input.observedCoverageQuantumMs || 15_000);
  const remainingDayMs = Math.max(0, input.remainingDayMs || (1 - elapsed) * 86_400_000);
  const nominalCoverageCapacity = Math.floor(remainingDayMs / quantumMs);
  const projectedContacts = Math.max(0, input.confirmedContacts) + nominalCoverageCapacity * 2;

  if (input.coverageEligible <= 0 && input.continuationEligible <= 0) {
    return {
      totalSlots,
      coverageSlots: 0,
      continuationSlots: 0,
      requiredByNow,
      coverageDebt,
      projectedContacts,
      reason: 'idle',
    };
  }
  if (input.confirmedContacts >= target) {
    const continuationSlots = input.continuationEligible > 0 ? totalSlots : 0;
    return {
      totalSlots,
      coverageSlots: 0,
      continuationSlots,
      requiredByNow,
      coverageDebt,
      projectedContacts,
      reason: 'coverage_complete',
    };
  }
  if (input.coverageEligible <= 0) {
    return {
      totalSlots,
      coverageSlots: 0,
      continuationSlots: totalSlots,
      requiredByNow,
      coverageDebt,
      projectedContacts,
      reason: 'coverage_idle_loan',
    };
  }
  if (input.continuationEligible <= 0) {
    return {
      totalSlots,
      coverageSlots: totalSlots,
      continuationSlots: 0,
      requiredByNow,
      coverageDebt,
      projectedContacts,
      reason: 'continuation_idle_loan',
    };
  }

  // When both lanes have work, reserve one slot for continuation so admitted
  // boards keep moving toward publication. The staging high-watermarks can
  // still shut coverage off completely if that handoff begins to accumulate.
  const coverageSlots = totalSlots === 1 ? 1 : totalSlots - 1;
  return {
    totalSlots,
    coverageSlots,
    continuationSlots: totalSlots - coverageSlots,
    requiredByNow,
    coverageDebt,
    projectedContacts,
    reason: 'coverage_target_remaining',
  };
}

export type AtsV2ContinuationCandidate = {
  id: string;
  platform: string;
  acquisitionPhase: string;
  lastServedAt: Date | null;
  nextAcquireAt: Date | null;
};

export function orderAtsV2ContinuationCandidates<T extends AtsV2ContinuationCandidate>(
  candidates: readonly T[],
  limit: number,
): T[] {
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = `${candidate.platform}\u0000${candidate.acquisitionPhase}`;
    groups.set(key, [...(groups.get(key) || []), candidate]);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => (
      (left.lastServedAt?.getTime() || 0) - (right.lastServedAt?.getTime() || 0)
      || (left.nextAcquireAt?.getTime() || 0) - (right.nextAcquireAt?.getTime() || 0)
      || left.id.localeCompare(right.id)
    ));
  }
  const keys = [...groups.keys()].sort();
  const selected: T[] = [];
  while (selected.length < take) {
    let progressed = false;
    for (const key of keys) {
      const next = groups.get(key)?.shift();
      if (!next) continue;
      selected.push(next);
      progressed = true;
      if (selected.length === take) break;
    }
    if (!progressed) break;
  }
  return selected;
}

export async function selectNextAtsV2CoverageBoard(now = new Date()): Promise<AtsBoardForAcquisition | null> {
  const today = rotationDayFor(now);
  const sizeAware = await atsDistributedArchitectureActive();
  const tiers: Prisma.AtsCompanyWhereInput[] = [
    {
      acquisitionEngine: 'v2',
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: today,
    },
    {
      acquisitionEngine: 'v2',
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: { not: today },
    },
    {
      acquisitionEngine: 'v2',
      status: { in: [...ATS_RECOVERY_STATUSES] },
      nextCheckDate: { lte: now },
    },
  ];
  for (const tier of tiers) {
    // Bound the candidate pool by age first, then apply the size advantage in
    // memory. A full overdue day promotes one size tier, so this never becomes
    // a permanent small-board barrier.
    const candidates = await prisma.atsCompany.findMany({
      where: {
        ...tier,
        ingestionBatches: {
          none: { status: { in: ['fetching', 'partial', 'synchronized'] } },
        },
      },
      orderBy: sizeAware
        ? [
            { nextCheckDate: 'asc' },
            { lastAttemptedAt: { sort: 'asc', nulls: 'first' } },
            { platform: 'asc' },
            { slug: 'asc' },
          ]
        : [
            { lastAttemptedAt: { sort: 'asc', nulls: 'first' } },
            { nextCheckDate: 'asc' },
            { platform: 'asc' },
            { slug: 'asc' },
          ],
      take: 1_000,
      select: {
        slug: true,
        platform: true,
        status: true,
        failCount: true,
        retryCount: true,
        checkDay: true,
        jobsFound: true,
        nextCheckDate: true,
        lastAttemptedAt: true,
      },
    });
    const board = sizeAware ? orderAtsCoverageCandidates(candidates, now)[0] : candidates[0];
    if (board) return board;
  }
  return null;
}

export async function claimNextAtsV2Coverage(now = new Date()): Promise<AtsLedgerClaim | null> {
  if (!await atsNewBoardAdmissionsAllowed()) return null;
  const staging = await atsV2StagingSnapshot();
  if (staging.blocked) return null;
  const board = await selectNextAtsV2CoverageBoard(now);
  if (!board) return null;
  return admitAtsV2Board({ slug: board.slug, platform: board.platform, now });
}

function isPaginated(platform: string): boolean {
  return atsListingPageSize(platform) !== null;
}

export function planAtsV2PageCompletion(input: {
  platform: string;
  requestedOffset: number;
  responseCount: number;
  providerTotal: number | null;
}): { listingComplete: boolean; anomaly: string | null } {
  const pageSize = atsListingPageSize(input.platform);
  if (pageSize === null) return { listingComplete: true, anomaly: null };
  const nextOffset = input.requestedOffset + input.responseCount;
  if (input.providerTotal !== null && nextOffset < input.providerTotal && input.responseCount < pageSize) {
    return {
      listingComplete: false,
      anomaly: `ATS ${input.platform} returned a short page before its reported total.`,
    };
  }
  return {
    listingComplete: input.responseCount < pageSize
      || (input.providerTotal !== null && nextOffset >= input.providerTotal),
    anomaly: null,
  };
}

async function runAtsV2ListingQuantum(
  claim: AtsLedgerClaim,
  signal?: AbortSignal,
): Promise<{ yieldReason: string; nextAcquireAt?: Date; error?: string }> {
  const startedAt = Date.now();
  const pageBudget = claim.workType === 'coverage_listing' ? 1 : ATS_LEDGER_LISTING_PAGE_BUDGET;
  let requestedOffset = claim.listingOffset;
  let listingComplete = false;
  for (let pageIndex = 0; pageIndex < pageBudget; pageIndex++) {
    if (signal?.aborted) throw signal.reason || new Error('ATS v2 listing interrupted.');
    if (pageIndex > 0 && Date.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) {
      return { yieldReason: 'time_budget' };
    }
    const requestedAt = new Date();
    let requestStartedAt: Date | null = null;
    let responseReceived = false;
    let contactPersisted = false;
    try {
      const result = await fetchAtsBoardPage(
        claim,
        requestedOffset,
        signal,
        async () => {
          const intentAt = new Date();
          await recordAtsV2ListingDispatchIntent(claim, intentAt);
          // Set this only after the intent is durable. If the marker write
          // fails, fetchAtsBoardPage never dispatches the request and the
          // endpoint must not receive contact credit.
          requestStartedAt = intentAt;
        },
        async ({ respondedAt }) => {
          responseReceived = true;
          await confirmAtsV2ListingContact({ claim, contactedAt: respondedAt, responded: true });
          contactPersisted = true;
        },
      );
      const completion = planAtsV2PageCompletion({
        platform: claim.platform,
        requestedOffset,
        responseCount: result.jobs.length,
        providerTotal: result.total,
      });
      const committed = await commitAtsV2ListingPage({
        claim,
        requestedOffset,
        requestedLimit: atsListingPageSize(claim.platform) || Math.max(1, result.jobs.length),
        providerOffset: isPaginated(claim.platform) ? requestedOffset : 0,
        providerTotal: result.total,
        jobs: result.jobs,
        metadata: result.metadata,
        requestedAt,
        respondedAt: new Date(),
        httpStatus: result.status,
        listingComplete: completion.listingComplete,
      });
      requestedOffset = committed.nextOffset;
      await recordProviderSuccess(`ATS-${claim.platform}`, new Date()).catch(() => undefined);
      listingComplete = completion.listingComplete;
      while (committed.observationCount < result.jobs.length) {
        const materialized = await materializeAtsV2PageObservations({
          claim,
          pageId: committed.pageId,
          listingComplete,
        });
        if (materialized.complete) break;
        if (Date.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) {
          return { yieldReason: 'materialization_budget' };
        }
      }
      if (completion.anomaly) {
        return {
          yieldReason: 'catalog_anomaly',
          nextAcquireAt: new Date(Date.now() + 15 * 60_000),
          error: completion.anomaly,
        };
      }
      if (listingComplete) return { yieldReason: 'listing_complete' };
    } catch (error) {
      if (requestStartedAt && !contactPersisted) {
        await confirmAtsV2ListingContact({
          claim,
          contactedAt: new Date(),
          responded: responseReceived,
        }).catch(() => undefined);
      }
      if (signal?.aborted) throw error;
      if (isAtsProviderWideError(error)) {
        await recordProviderFailure({ provider: `ATS-${claim.platform}`, error }).catch(() => undefined);
      }
      return {
        yieldReason: 'error',
        nextAcquireAt: new Date(Date.now() + 15 * 60_000),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { yieldReason: listingComplete ? 'listing_complete' : 'page_budget' };
}

async function runAtsV2ContinuationQuantum(
  claim: AtsLedgerClaim,
  signal?: AbortSignal,
): Promise<{ yieldReason: string; nextAcquireAt?: Date; error?: string }> {
  const startedAt = Date.now();
  if (claim.acquisitionPhase === 'compaction') {
    while (Date.now() - startedAt < ATS_LEDGER_QUANTUM_SOFT_MS) {
      const result = await resolveNextAtsV2ObservationChunk({ claim });
      if (result.complete) return { yieldReason: 'compaction_complete' };
      if (result.resolved === 0) break;
    }
    return { yieldReason: 'compaction_budget' };
  }

  if (claim.acquisitionPhase === 'enrichment' || claim.acquisitionPhase === 'sealing') {
    if (claim.acquisitionPhase === 'enrichment') {
      await terminalizeAtsV2NoNetworkItems({ claim });
      for (let requestIndex = 0; requestIndex < ATS_LEDGER_DETAIL_REQUEST_BUDGET; requestIndex++) {
        if (signal?.aborted) throw signal.reason || new Error('ATS v2 enrichment interrupted.');
        if (requestIndex > 0 && Date.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) break;
        const result = await enrichNextAtsV2DetailItem({
          claim,
          signal,
          requestTimeoutMs: 10_000,
        });
        if (result === 'none') break;
        if (result === 'deferred') break;
      }
    }
    const sealed = await sealReadyAtsV2Segments({ claim });
    return { yieldReason: sealed.complete ? 'segments_sealed' : 'enrichment_budget' };
  }

  return { yieldReason: 'no_eligible_phase', nextAcquireAt: new Date(Date.now() + 60_000) };
}

export async function runAtsV2Claim(claim: AtsLedgerClaim, signal?: AbortSignal): Promise<void> {
  let outcome: { yieldReason: string; nextAcquireAt?: Date; error?: string };
  try {
    outcome = claim.acquisitionPhase === 'listing'
      ? await runAtsV2ListingQuantum(claim, signal)
      : await runAtsV2ContinuationQuantum(claim, signal);
  } catch (error) {
    outcome = {
      yieldReason: signal?.aborted ? 'interrupted' : 'error',
      nextAcquireAt: signal?.aborted ? new Date() : new Date(Date.now() + 60_000),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const retained = await finishAtsV2Claim({
    claim,
    yieldReason: outcome.yieldReason,
    nextAcquireAt: outcome.nextAcquireAt,
    error: outcome.error,
  });
  if (!retained) throw new Error(`ATS v2 claim ${claim.workReceiptId} lost its release fence.`);
}

export type AtsV2DispatcherProgress = {
  lane: AtsV2Lane;
  workerIndex: number;
  claim: AtsLedgerClaim;
};

export type AtsV2DispatcherError = {
  workerIndex: number;
  phase: 'plan' | 'claim' | 'run' | 'reconcile';
  error: unknown;
};

export type AtsV2PublisherProgress = {
  publishedSegments: number;
  publishedItems: number;
  remainingJobs: number;
};

function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Continuously drain globally oldest sealed manifests without borrowing one of
 * the four provider/acquisition slots. Publication is network-free; the ledger
 * advisory lock and persistent high/low gate remain its serialization and
 * pressure authority.
 */
export async function runAtsV2ContinuousPublisher(input: {
  signal: AbortSignal;
  idleDelayMs?: number;
  onProgress?: (progress: AtsV2PublisherProgress) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const idleDelayMs = Math.max(100, Math.floor(input.idleDelayMs || 1_000));
  while (!input.signal.aborted) {
    try {
      const progress = await publishReadyAtsV2Segments({
        highWatermark: ATS_ACQUISITION_JOB_HIGH_WATERMARK,
        lowWatermark: ATS_ACQUISITION_JOB_LOW_WATERMARK,
        maxSegments: ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION,
      });
      if (progress.publishedSegments > 0) input.onProgress?.(progress);
      if (progress.publishedSegments < ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION) {
        await waitForAbortableDelay(input.signal, idleDelayMs);
      }
    } catch (error) {
      input.onError?.(error);
      await waitForAbortableDelay(input.signal, idleDelayMs);
    }
  }
}

export async function runAtsV2ContinuousDispatcher(input: {
  signal: AbortSignal;
  totalSlots?: number;
  plan: () => Promise<AtsV2LanePlan>;
  lanePolicy?: 'balanced' | 'continuation-only';
  onProgress?: (progress: AtsV2DispatcherProgress) => void;
  onError?: (failure: AtsV2DispatcherError) => void;
  idleDelayMs?: number;
}): Promise<void> {
  const totalSlots = Math.max(1, Math.min(
    ATS_ACQUISITION_CONCURRENCY,
    Math.floor(input.totalSlots || ATS_ACQUISITION_CONCURRENCY),
  ));
  const idleDelayMs = Math.max(100, Math.floor(input.idleDelayMs || 1_000));
  const delay = () => waitForAbortableDelay(input.signal, idleDelayMs);
  await reconcileExpiredAtsV2Work();

  let nextReconcileAt = Date.now() + 60_000;
  let reconciliation: Promise<void> | null = null;
  const reconcileIfDue = async (workerIndex: number) => {
    if (Date.now() < nextReconcileAt) return;
    if (!reconciliation) {
      nextReconcileAt = Date.now() + 60_000;
      reconciliation = reconcileExpiredAtsV2Work()
        .then(() => undefined)
        .catch((error) => input.onError?.({ workerIndex, phase: 'reconcile', error }))
        .finally(() => { reconciliation = null; });
    }
    await reconciliation;
  };

  const workers = Array.from({ length: totalSlots }, async (_unused, workerIndex) => {
    while (!input.signal.aborted) {
      try {
        await reconcileIfDue(workerIndex);
        const plan = await input.plan();
        const continuationOnly = input.lanePolicy === 'continuation-only';
        const lane: AtsV2Lane = continuationOnly
          ? 'continuation'
          : workerIndex < plan.coverageSlots ? 'coverage' : 'continuation';
        let claim = lane === 'coverage'
          ? await claimNextAtsV2Coverage()
          : await claimNextAtsV2Continuation();
        let effectiveLane = lane;
        const mayBorrowOtherLane = !continuationOnly
          && (lane === 'coverage' || plan.coverageSlots > 0);
        if (!claim && mayBorrowOtherLane) {
          effectiveLane = lane === 'coverage' ? 'continuation' : 'coverage';
          claim = effectiveLane === 'coverage'
            ? await claimNextAtsV2Coverage()
            : await claimNextAtsV2Continuation();
        }
        if (!claim) {
          await delay();
          continue;
        }
        input.onProgress?.({ lane: effectiveLane, workerIndex, claim });
        try {
          await runAtsV2Claim(claim, input.signal);
        } catch (error) {
          input.onError?.({ workerIndex, phase: 'run', error });
          await delay();
        }
      } catch (error) {
        input.onError?.({ workerIndex, phase: 'claim', error });
        await delay();
      }
    }
  });
  await Promise.allSettled(workers);
}

export async function atsV2ShadowLanePlan(now = new Date()): Promise<AtsV2LanePlan & {
  coverageEligible: number;
  continuationEligible: number;
  drainEligible: number;
}> {
  const [row] = await prisma.$queryRaw<Array<{
    confirmedContacts: bigint | number | string;
    coverageEligible: bigint | number | string;
    continuationEligible: bigint | number | string;
    drainEligible: bigint | number | string;
    elapsedFraction: number | string;
    remainingDayMs: bigint | number | string;
  }>>`
    WITH chicago_day AS (
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date AS local_day,
        ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date::timestamp AT TIME ZONE 'America/Chicago') AS day_start,
        ((((CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date + 1)::timestamp) AT TIME ZONE 'America/Chicago') AS day_end
    )
    SELECT
      (SELECT COUNT(*) FROM "AtsEndpointDailyContactReceipt" contact, chicago_day day
        WHERE contact."localDay" = day.local_day
          AND contact."contactKind" = 'new_cycle_listing') AS "confirmedContacts",
      (SELECT COUNT(*) FROM "AtsCompany" board
        WHERE board."acquisitionEngine" = 'v2'
          AND board.status IN ('active', 'parked', 'blacklisted')
          AND board."nextCheckDate" <= ${now}) AS "coverageEligible",
      (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
        WHERE batch."writerMode" = 'v2'
          AND batch.status IN ('fetching', 'partial', 'synchronized', 'reset_draining')
          AND batch."acquisitionPhase" IN ('listing', 'compaction', 'enrichment', 'sealing')
          AND (batch."nextAcquireAt" IS NULL OR batch."nextAcquireAt" <= ${now})) AS "continuationEligible",
      (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
        WHERE batch."writerMode" = 'v2'
          AND batch.status IN ('fetching', 'partial', 'synchronized', 'reset_draining')
          AND batch."acquisitionPhase" IN ('compaction', 'enrichment', 'sealing')
          AND (batch."nextAcquireAt" IS NULL OR batch."nextAcquireAt" <= ${now})) AS "drainEligible",
      GREATEST(0, LEAST(1,
        EXTRACT(EPOCH FROM (${now} - day.day_start))
        / NULLIF(EXTRACT(EPOCH FROM (day.day_end - day.day_start)), 0)
      )) AS "elapsedFraction",
      GREATEST(0, EXTRACT(EPOCH FROM (day.day_end - ${now})) * 1000)::bigint AS "remainingDayMs"
    FROM chicago_day day
  `;
  const coverageEligible = Number(row?.coverageEligible || 0);
  const continuationEligible = Number(row?.continuationEligible || 0);
  const drainEligible = Number(row?.drainEligible || 0);
  return {
    drainEligible,
    ...planAtsV2LaneReservation({
      confirmedContacts: Number(row?.confirmedContacts || 0),
      elapsedDayFraction: Number(row?.elapsedFraction || 0),
      remainingDayMs: Number(row?.remainingDayMs || 0),
      coverageEligible,
      continuationEligible,
    }),
    coverageEligible,
    continuationEligible,
  };
}

export async function atsV2RuntimeLanePlan(
  totalSlots = ATS_ACQUISITION_V2_SLOT_COUNT,
  now = new Date(),
): Promise<AtsV2LanePlan> {
  const shadow = await atsV2ShadowLanePlan(now);
  const slots = Math.max(1, Math.min(ATS_ACQUISITION_CONCURRENCY, Math.floor(totalSlots)));
  // Coverage cannot admit anything while staging is over its own high
  // watermark, and every slot pointed at it would idle-poll and then borrow
  // continuation anyway. Say so in the plan instead of discovering it per
  // claim, and keep coverage to one slot whenever there is already enough
  // acquired work to occupy the lane.
  const staging = await atsV2StagingSnapshot();
  const drainSaturated = shadow.drainEligible >= slots;
  if (staging.blocked) {
    return {
      ...shadow,
      totalSlots: slots,
      coverageSlots: 0,
      continuationSlots: slots,
      reason: 'staging_blocked',
    };
  }
  if (drainSaturated && shadow.continuationEligible > 0) {
    const coverageSlots = shadow.coverageEligible > 0
      ? Math.min(ATS_V2_COVERAGE_SLOTS_WHILE_DRAINING, slots - 1)
      : 0;
    return {
      ...shadow,
      totalSlots: slots,
      coverageSlots,
      continuationSlots: slots - coverageSlots,
      reason: 'draining',
    };
  }
  if (shadow.coverageEligible <= 0 || shadow.continuationEligible <= 0) {
    const coverageSlots = shadow.coverageEligible > 0 && shadow.coverageSlots > 0 ? slots : 0;
    const continuationSlots = shadow.continuationEligible > 0 ? slots : 0;
    return {
      ...shadow,
      totalSlots: slots,
      coverageSlots,
      continuationSlots,
      reason: shadow.reason === 'coverage_complete'
        ? shadow.reason
        : shadow.coverageEligible > 0 ? 'continuation_idle_loan' : 'coverage_idle_loan',
    };
  }
  const coverageSlots = slots === 1
    ? (shadow.coverageDebt > 0 ? 1 : 0)
    : shadow.coverageSlots === 0
      ? 0
      : Math.min(slots - 1, shadow.coverageSlots >= 3 ? slots - 1 : Math.ceil(slots / 2));
  return {
    ...shadow,
    totalSlots: slots,
    coverageSlots,
    continuationSlots: slots - coverageSlots,
  };
}

export type AtsV2ShadowSelection = {
  lanePlan: Awaited<ReturnType<typeof atsV2ShadowLanePlan>>;
  continuationWouldSelect: AtsV2ContinuationCandidate[];
};

export async function shadowAtsV2Scheduler(now = new Date()): Promise<AtsV2ShadowSelection> {
  const lanePlan = await atsV2ShadowLanePlan(now);
  const candidates = await prisma.atsIngestionBatch.findMany({
    where: {
      writerMode: 'v2',
      status: { in: ['fetching', 'partial', 'synchronized', 'reset_draining'] },
      acquisitionPhase: { in: ['listing', 'compaction', 'enrichment', 'sealing'] },
      OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
    },
    select: {
      id: true,
      platform: true,
      acquisitionPhase: true,
      lastServedAt: true,
      nextAcquireAt: true,
    },
    take: 100,
  });
  return {
    lanePlan,
    continuationWouldSelect: orderAtsV2ContinuationCandidates(
      candidates,
      Math.max(1, lanePlan.continuationSlots),
    ),
  };
}

export type AtsV2Board = Pick<AtsCompany, 'slug' | 'platform'>;
