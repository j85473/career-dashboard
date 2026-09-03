import { Prisma, type AtsCompany } from '@prisma/client';

import {
  atsListingPageSize,
  fetchAtsBoardPage,
  isAtsBoardLevelFailure,
  isAtsProviderWideError,
  nextAtsFailureSchedule,
  orderAtsCoverageCandidates,
  type AtsBoardForAcquisition,
} from './atsAcquisition';
import {
  ATS_LEDGER_DETAIL_REQUEST_BUDGET,
  ATS_LEDGER_LISTING_PAGE_BUDGET,
  ATS_LEDGER_QUANTUM_SOFT_MS,
  ATS_LEDGER_WORK_LEASE_MS,
  admitAtsV2Board,
  atsV2StagingSnapshot,
  claimNextAtsV2Continuation,
  commitAtsV2ListingPage,
  confirmAtsV2ListingContact,
  markAtsV2BoardResponded,
  enrichNextAtsV2DetailItem,
  finishAtsV2Claim,
  heartbeatAtsV2Claim,
  materializeAtsV2PageObservations,
  publishReadyAtsV2Segments,
  readAtsV2ListingCheckpoint,
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
import { ATS_DAILY_BOARD_TARGET, ATS_RECOVERY_STATUSES, ATS_ROTATION_STATUSES, nextAtsBoardCheckDateForDay, rotationDayFor } from './atsRotation';
import { assertAtsV2AuthorityActive } from './atsAcquisitionCompatibility';
import { prisma } from './prisma';
import { RateLimitedError } from './jobIngestion';
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
/** Bounded retry for an ordinary transient listing failure. */
export const ATS_V2_LISTING_RETRY_MS = 15 * 60_000;
/**
 * Separate days a board must fail on before a failure may demote it.
 *
 * Days, not attempts, because the failure modes this system actually suffers
 * are bursts: one bad classification takes a platform down and every board on
 * it fails together for hours. Requiring the failures to survive a night means
 * an incident cannot demote anything, however many attempts it burns.
 */
export const ATS_DEMOTION_MIN_DISTINCT_DAYS = 3;
/** Boards a failure may reschedule. Excluded boards are never revived. */
const ATS_SCHEDULABLE_STATUSES: readonly string[] = [...ATS_ROTATION_STATUSES, ...ATS_RECOVERY_STATUSES];
/**
 * How long a batch waits after a continuation quantum that could not progress.
 * Long enough to stop a spin, short enough that a deferral which clears within
 * the minute costs at most one cycle. Matches the `no_eligible_phase` backoff.
 */
export const ATS_V2_CONTINUATION_IDLE_RETRY_MS = 60_000;
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
  // Daily coverage is a finish-as-fast-as-safe goal, not a work ceiling.
  // Staging and persistence backpressure below decide when new coverage must
  // yield; after the goal is met, spare capacity keeps serving today's active
  // cohort, overdue active boards, and then due recovery boards.
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
    reason: coverageDebt > 0 ? 'coverage_target_remaining' : 'coverage_goal_met',
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

/**
 * A provider circuit already knows when it will reopen, and AtsProviderBlockedError
 * carries that instant. Ignoring it and sleeping a flat 15 minutes makes every
 * board behind an open circuit wake, get refused locally, and re-defer for as
 * long as the circuit stays shut -- thousands of boards cycling roughly twenty
 * times across a six-hour outage while holding lanes that runnable work needs.
 * The detail-enrichment path already honours this; listing did not.
 *
 * A retryAt in the past, or none at all, falls back to the ordinary bounded
 * retry, so an ordinary transient error keeps its short backoff.
 */
export function atsListingRetryAt(
  error: unknown,
  now: Date = new Date(),
  fallbackMs: number = ATS_V2_LISTING_RETRY_MS,
): Date {
  const fallback = new Date(now.getTime() + fallbackMs);
  if (!error || typeof error !== 'object' || !('retryAt' in error)) return fallback;
  const retryAt = (error as { retryAt?: unknown }).retryAt;
  if (!(retryAt instanceof Date) || Number.isNaN(retryAt.getTime())) return fallback;
  return retryAt.getTime() > fallback.getTime() ? retryAt : fallback;
}

const listingDependencies = {
  fetchAtsBoardPage,
  readAtsV2ListingCheckpoint,
  commitAtsV2ListingPage,
  materializeAtsV2PageObservations,
  recordAtsV2ListingDispatchIntent,
  confirmAtsV2ListingContact,
  markAtsV2BoardResponded,
  recordProviderSuccess,
  recordProviderFailure,
  now: () => Date.now(),
};

export async function runAtsV2ListingQuantum(
  claim: AtsLedgerClaim,
  signal?: AbortSignal,
  dependencies = listingDependencies,
): Promise<{ yieldReason: string; nextAcquireAt?: Date; error?: string; boardFailure?: boolean }> {
  const startedAt = dependencies.now();
  const pageBudget = claim.workType === 'coverage_listing' ? 1 : ATS_LEDGER_LISTING_PAGE_BUDGET;
  let requestedOffset = claim.listingOffset;
  let listingComplete = false;
  const materialize = async (pageId: string, completeListing: boolean): Promise<boolean> => {
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error('ATS v2 listing interrupted.');
      const result = await dependencies.materializeAtsV2PageObservations({
        claim, pageId, listingComplete: completeListing,
      });
      if (result.complete) return true;
      if (dependencies.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) return false;
    }
  };

  // A committed response advances listingOffset even when its rows still need
  // several turns to materialize. Resume those rows, not the provider cursor.
  // Completion comes from the latest saved response, while older unfinished
  // responses are drained in order without discarding any stored evidence.
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('ATS v2 listing interrupted.');
    const checkpoint = await dependencies.readAtsV2ListingCheckpoint(claim);
    const completion = checkpoint.latestPage && planAtsV2PageCompletion({
      platform: claim.platform,
      requestedOffset: checkpoint.latestPage.requestedOffset,
      responseCount: checkpoint.latestPage.responseItemCount,
      providerTotal: checkpoint.latestPage.providerTotal,
    });
    if (!checkpoint.pendingPage) {
      if (completion?.listingComplete) return { yieldReason: 'listing_complete' };
      break;
    }
    if (!await materialize(checkpoint.pendingPage.id, completion?.listingComplete === true)) {
      return { yieldReason: 'materialization_budget' };
    }
    if (dependencies.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) {
      return { yieldReason: 'materialization_budget' };
    }
  }
  for (let pageIndex = 0; pageIndex < pageBudget; pageIndex++) {
    if (signal?.aborted) throw signal.reason || new Error('ATS v2 listing interrupted.');
    if (dependencies.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) {
      return { yieldReason: 'time_budget' };
    }
    const requestedAt = new Date();
    let requestStartedAt: Date | null = null;
    let responseReceived = false;
    let contactPersisted = false;
    let contactedAt: Date | null = null;
    try {
      const result = await dependencies.fetchAtsBoardPage(
        claim,
        requestedOffset,
        signal,
        async () => {
          const intentAt = new Date();
          await dependencies.recordAtsV2ListingDispatchIntent(claim, intentAt);
          // Set this only after the intent is durable. If the marker write
          // fails, fetchAtsBoardPage never dispatches the request and the
          // endpoint must not receive contact credit.
          requestStartedAt = intentAt;
        },
        async ({ respondedAt }) => {
          responseReceived = true;
          // The contact receipt is persisted here, before validation, so a 500
          // or a malformed body still counts as the endpoint having been
          // reached. The board's own `lastRespondedAt` is deliberately not
          // credited yet: a retired BambooHR subdomain redirects to the
          // vendor's marketing homepage and answers 200 with HTML, and
          // crediting that refreshed the board's health clock every time it
          // failed, which is why 4,729 dead boards kept their fast re-check
          // cadence indefinitely. Only a response we could actually read as a
          // job listing counts as the board answering.
          await dependencies.confirmAtsV2ListingContact({ claim, contactedAt: respondedAt, responded: false });
          contactPersisted = true;
          contactedAt = respondedAt;
        },
      );
      if (contactedAt) {
        await dependencies.markAtsV2BoardResponded({ claim, respondedAt: contactedAt });
      }
      const completion = planAtsV2PageCompletion({
        platform: claim.platform,
        requestedOffset,
        responseCount: result.jobs.length,
        providerTotal: result.total,
      });
      const committed = await dependencies.commitAtsV2ListingPage({
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
      await dependencies.recordProviderSuccess(`ATS-${claim.platform}`, new Date()).catch(() => undefined);
      listingComplete = completion.listingComplete;
      if (committed.observationCount < result.jobs.length
        && !await materialize(committed.pageId, listingComplete)) {
        return { yieldReason: 'materialization_budget' };
      }
      if (completion.anomaly) {
        return {
          yieldReason: 'catalog_anomaly',
          nextAcquireAt: new Date(Date.now() + ATS_V2_LISTING_RETRY_MS),
          error: completion.anomaly,
        };
      }
      if (listingComplete) return { yieldReason: 'listing_complete' };
    } catch (error) {
      if (requestStartedAt && !contactPersisted) {
        await dependencies.confirmAtsV2ListingContact({
          claim,
          contactedAt: new Date(),
          responded: responseReceived,
        }).catch(() => undefined);
      }
      if (signal?.aborted) throw error;
      // A 429 is already recorded at the response boundary, with the platform's
      // own Retry-After as the window. Recording it a second time here adds
      // nothing except a second increment of consecutiveFailures, which makes
      // one rate limit escalate the backoff as if it were two.
      if (!(error instanceof RateLimitedError) && isAtsProviderWideError(error, claim.platform)) {
        await dependencies.recordProviderFailure({ provider: `ATS-${claim.platform}`, error }).catch(() => undefined);
      }
      return {
        yieldReason: 'error',
        nextAcquireAt: atsListingRetryAt(error),
        error: error instanceof Error ? error.message : String(error),
        boardFailure: isAtsBoardLevelFailure(error),
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
    let progressed = false;
    if (claim.acquisitionPhase === 'enrichment') {
      const marked = await terminalizeAtsV2NoNetworkItems({ claim });
      if (marked.terminalized > 0) progressed = true;
      for (let requestIndex = 0; requestIndex < ATS_LEDGER_DETAIL_REQUEST_BUDGET; requestIndex++) {
        if (signal?.aborted) throw signal.reason || new Error('ATS v2 enrichment interrupted.');
        if (requestIndex > 0 && Date.now() - startedAt >= ATS_LEDGER_QUANTUM_SOFT_MS) break;
        const result = await enrichNextAtsV2DetailItem({
          claim,
          signal,
          requestTimeoutMs: 10_000,
        });
        if (result === 'terminal') progressed = true;
        if (result === 'none') break;
        if (result === 'deferred') break;
      }
    }
    const sealed = await sealReadyAtsV2Segments({ claim });
    if (sealed.sealedSegments > 0) progressed = true;
    if (sealed.complete) return { yieldReason: 'segments_sealed' };
    // A quantum that terminalized nothing, enriched nothing and sealed nothing
    // must not stay instantly re-claimable. `finishAtsV2Claim` treats an absent
    // nextAcquireAt as "eligible now", and every other yield reason in this
    // dispatcher already carries a retry time -- this one did not. On
    // 2026-09-01 that spun 112 enrichment batches at roughly ten claims per
    // second across all eight lanes for two hours: 73,664 work receipts that
    // made 1,893 detail requests between them, while 4,641 listing batches
    // waited for a lane that never freed and no board completed for 115
    // minutes. A quantum that did make progress stays immediately eligible, so
    // a draining board is not slowed down.
    return {
      yieldReason: 'enrichment_budget',
      ...(progressed
        ? {}
        : { nextAcquireAt: new Date(Date.now() + ATS_V2_CONTINUATION_IDLE_RETRY_MS) }),
    };
  }

  return { yieldReason: 'no_eligible_phase', nextAcquireAt: new Date(Date.now() + 60_000) };
}

/**
 * A board the system already demoted to parked or blacklisted keeps its own
 * recovery cadence. Without this its listing batch retries every 15 minutes
 * forever, so a board removed from rotation for repeatedly 404-ing is still
 * contacted ~96 times a day -- real external requests, unlike a circuit block.
 *
 * This honours a demotion that has already happened; it never demotes a board,
 * changes a board's status, or discards acquired work. An active board is
 * untouched and keeps the ordinary bounded retry.
 *
 * Callers must apply this to the listing phase only. "Never discards acquired
 * work" is true of this function in isolation and was not true of how it was
 * called: routing drain-phase retries through it parked already-downloaded
 * postings for a week, which is not a lighter touch on the board, only a slower
 * one on work the board has no further part in.
 *
 * `boardFailure` is required rather than optional, and the check lives here
 * rather than at the call site, because this rule has now been got wrong twice
 * in two different phases by a caller that simply did not apply it. A caller
 * can forget a condition; it cannot forget an argument the compiler demands.
 * Pass the verdict of `isAtsBoardLevelFailure` and nothing else -- it is the
 * one authority on whether a failure was the board's own, and a refusal this
 * pipeline made itself (an open circuit, a budget refusal, a 429) never
 * reached the board and so may not move the board's schedule.
 */
async function recoveryAwareRetryAt(
  claim: AtsLedgerClaim,
  proposed: Date | undefined,
  boardFailure: boolean | undefined,
): Promise<Date | undefined> {
  if (!boardFailure) return proposed;
  if (!proposed) return proposed;
  const board = await prisma.atsCompany.findUnique({
    where: { slug_platform: { slug: claim.slug, platform: claim.platform } },
    select: { status: true, checkDay: true },
  });
  if (!board || !ATS_RECOVERY_STATUSES.includes(board.status as typeof ATS_RECOVERY_STATUSES[number])) {
    return proposed;
  }
  const recoveryAt = nextAtsBoardCheckDateForDay(board.checkDay);
  return recoveryAt.getTime() > proposed.getTime() ? recoveryAt : proposed;
}

/**
 * How often a running claim renews its lease.
 *
 * The lease exists to detect a worker that died, not one that is merely slow.
 * Without renewal the two are indistinguishable, and a quantum that outruns the
 * lease has its batch stolen by another lane: the fence moves, and the original
 * worker's finish is rejected as "lost its release fence" -- throwing away work
 * that had actually completed.
 *
 * That is not a rare edge. Measured on 2026-09-03, 51 of 87 finished claims in
 * half an hour ran past the 180s lease, averaging 149s, because a throttled
 * platform makes a quantum wait rather than work. All eight lanes churned on
 * Personio, nothing reached `processed` for six and a half hours, and the
 * compaction backlog grew to 8,500 batches.
 *
 * A third of the lease keeps two renewals in hand before expiry, so a single
 * slow database round trip cannot cost the claim.
 */
export const ATS_V2_CLAIM_HEARTBEAT_MS = Math.max(15_000, Math.floor(ATS_LEDGER_WORK_LEASE_MS / 3));

export async function runAtsV2Claim(claim: AtsLedgerClaim, signal?: AbortSignal): Promise<void> {
  let outcome: { yieldReason: string; nextAcquireAt?: Date; error?: string; boardFailure?: boolean };
  // Renewal is best-effort and never fails the quantum. A heartbeat that cannot
  // land leaves the claim exactly where it was without this timer: expiring on
  // the original lease.
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating || signal?.aborted) return;
    beating = true;
    heartbeatAtsV2Claim(claim)
      .catch(() => undefined)
      .finally(() => { beating = false; });
  }, ATS_V2_CLAIM_HEARTBEAT_MS);
  // Never hold the process open for a renewal timer.
  heartbeat.unref?.();
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
  } finally {
    // Stopped before the claim is settled: renewing a lease the finish is about
    // to release would re-open a window this claim no longer needs.
    clearInterval(heartbeat);
  }
  // Only listing gets the demoted board's weekly cadence. Listing is the phase
  // that re-contacts the board's own endpoint on a bounded retry forever, so
  // slowing it to the recovery slot is the whole point of that rule.
  //
  // The drain phases are not that. Their items are already downloaded; what
  // remains is finite work that ends when the board's postings are consumed,
  // and holding it back does not spare the board a single listing request.
  // Applying the weekly slot to them froze 12,253 acquired postings across 22
  // batches for seven days on 2026-09-02 -- work that needed no further contact
  // to finish, parked because the board it came from had been demoted after the
  // postings were already in hand.
  //
  // The same test decides it a second time, on the error rather than the phase.
  // A circuit block, a budget refusal or a 429 is refused inside this process
  // and never reaches the board, so slowing it to the recovery slot spares that
  // board nothing -- it is the drain-phase mistake again, one layer up. It held
  // 4,593 listing batches for ~6.5 days on 2026-09-02 (2,043 Workday, 1,375
  // Personio, 674 Workday parked, 494 Workable, 7 Workable parked) behind
  // circuits whose own reopen time was six hours, which is most of why Workday
  // intake fell 47,475 -> 8,528 across the M70 move. `isAtsBoardLevelFailure`
  // is the one authority on "the board's own failure"; only its verdict may
  // reach board-derived scheduling, exactly as it already gates the failure
  // record below. An error whose origin we cannot establish keeps the ordinary
  // bounded retry, which costs one short cycle and never strands work.
  //
  // The origin is passed rather than tested here on purpose: the rule now lives
  // inside the function that applies it, so a future caller cannot reintroduce
  // this by omitting a condition. See recoveryAwareRetryAt.
  const nextAcquireAt = outcome.yieldReason === 'error' && claim.acquisitionPhase === 'listing'
    ? await recoveryAwareRetryAt(claim, outcome.nextAcquireAt, outcome.boardFailure)
      .catch(() => outcome.nextAcquireAt)
    : outcome.nextAcquireAt;
  if (outcome.yieldReason === 'error' && outcome.boardFailure && claim.acquisitionPhase === 'listing') {
    // Best-effort: the batch's own outcome is the authority and must still be
    // recorded even if the board row cannot be updated.
    await recordAtsV2BoardListingFailure(claim, new Date()).catch(() => undefined);
  }
  const retained = await finishAtsV2Claim({
    claim,
    yieldReason: outcome.yieldReason,
    nextAcquireAt,
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
      reason: shadow.coverageEligible > 0 ? 'continuation_idle_loan' : 'coverage_idle_loan',
    };
  }
  const coverageSlots = slots === 1
    ? (shadow.coverageSlots > 0 ? 1 : 0)
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

/**
 * Record a listing failure against the board, not just against its batch.
 *
 * v2 tracked failure only on the batch's own `nextAcquireAt`, and reset the
 * board's `failCount` on success without ever incrementing it. So a failing
 * board left no mark: once its batch reached a terminal state the board fell
 * back to its weekly rotation slot with `failCount` still 0, and nothing
 * escalated the retry. On 2026-09-02 that left 1,400 boards contacted exactly
 * once, never answering, each waiting a full week to be tried again -- 1,324 of
 * them with no pending retry at all.
 *
 * The ladder is `nextAtsFailureSchedule`, the legacy engine's, so both engines
 * age a failing board identically: two same-day retries, then a day, then a
 * week, then a month.
 *
 * Demotion is applied only on evidence that survives a bad day.
 *
 * The failure ladder alone is not that evidence. Three failures inside one
 * incident is what a broken pipeline looks like, not a bad board: on
 * 2026-09-02 a single misclassified error closed BambooHR and Workday for six
 * hours each, and 3,780 boards were demoted in one day against 31 across the
 * two days before. Any rule that demotes on a burst would have demoted
 * thousands of healthy boards that morning.
 *
 * So demotion additionally requires board-level failures on
 * ATS_DEMOTION_MIN_DISTINCT_DAYS separate days, counted from the receipts and
 * excluding every failure the pipeline imposed on itself. A board that fails
 * fifty times in one hour is retried and never demoted; a board that fails once
 * a day for three days is demoted. Without that evidence the schedule's retry
 * and failCount still apply and only the status change is withheld.
 */
async function recordAtsV2BoardListingFailure(claim: AtsLedgerClaim, now: Date): Promise<void> {
  const board = await prisma.atsCompany.findUnique({
    where: { slug_platform: { slug: claim.slug, platform: claim.platform } },
    select: { slug: true, platform: true, status: true, failCount: true, retryCount: true },
  });
  // An excluded board has been retired by an operator or an exclusion arm. It
  // must not be rescheduled back into the rotation by a late failure.
  if (!board || !ATS_SCHEDULABLE_STATUSES.includes(board.status)) return;
  const schedule = nextAtsFailureSchedule(
    { ...board, jobsFound: 0, checkDay: 0, nextCheckDate: now, lastAttemptedAt: now } as AtsBoardForAcquisition,
    now,
  );
  // The schedule wants to demote. Only let it if the board has failed on
  // separate days, so a single incident cannot demote anything.
  const demoting = schedule.status !== board.status;
  const confirmed = demoting ? await boardFailedOnDistinctDays(board.slug, board.platform) : false;
  await prisma.atsCompany.updateMany({
    where: { slug: board.slug, platform: board.platform, status: board.status },
    data: {
      retryCount: schedule.retryCount,
      failCount: schedule.failCount,
      nextCheckDate: schedule.nextCheckDate,
      lastAttemptedAt: now,
      ...(demoting && confirmed ? { status: schedule.status } : {}),
    },
  });
}

/**
 * Distinct days this board failed on its own account.
 *
 * Counted from the receipts rather than from failCount, because failCount
 * cannot tell three bad days from one bad hour. Pipeline-imposed failures are
 * excluded here as well as at the call site: a circuit block is recorded as a
 * receipt like any other, and counting one would let an outage supply the very
 * evidence used to justify demoting the boards it took offline.
 */
async function boardFailedOnDistinctDays(slug: string, platform: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ days: bigint }>>`
    select count(distinct date_trunc('day', w."startedAt")) as days
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
     where b.slug = ${slug}
       and b.platform = ${platform}
       and w."yieldReason" = 'error'
       and w."workType" in ('coverage_listing', 'listing_continuation')
       and w."startedAt" > now() - interval '30 days'
       and coalesce(w.error, '') !~* '(deferred by|circuit_open|rate.?limited this request)'
  `;
  return Number(rows[0]?.days ?? 0) >= ATS_DEMOTION_MIN_DISTINCT_DAYS;
}
