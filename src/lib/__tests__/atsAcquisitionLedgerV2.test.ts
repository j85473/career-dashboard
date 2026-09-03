import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_V2_ENABLED,
  ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED,
  ATS_ACQUISITION_V2_SHADOW_ENABLED,
  ATS_V2_CLAIM_HEARTBEAT_MS,
  ATS_V2_CONTINUATION_IDLE_RETRY_MS,
  ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION,
  atsListingRetryAt,
  orderAtsV2ContinuationCandidates,
  planAtsV2LaneReservation,
  planAtsV2PageCompletion,
} from '../atsAcquisitionDispatcherV2';
import {
  ATS_LEDGER_WORK_LEASE_MS,
  atsLedgerHash,
  atsV2BatchFinalizationReady,
  chicagoLocalDay,
  planAtsV2PublicationGate,
  type AtsV2BatchFinalizationSnapshot,
} from '../atsAcquisitionLedger';
import { validateAtsV2AuthorityActive } from '../atsAcquisitionCompatibility';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function finalizationSnapshot(
  overrides: Partial<AtsV2BatchFinalizationSnapshot> = {},
): AtsV2BatchFinalizationSnapshot {
  return {
    writerMode: 'v2',
    status: 'synchronized',
    processedAt: null,
    listingCompletedAt: new Date('2026-08-31T20:00:00.000Z'),
    synchronizedAt: new Date('2026-08-31T20:05:00.000Z'),
    acquisitionPhase: 'synchronized',
    rawObservationCount: 50,
    observationCount: 50,
    resolutionCount: 50,
    canonicalOccurrenceCount: 50,
    canonicalItemCount: 50,
    compactedOccurrenceCount: 0,
    terminalItemCount: 50,
    terminalItemRowCount: 50,
    sealedItemCount: 50,
    publishedItemCount: 50,
    segmentSize: 25,
    incompletePageCount: 0,
    liveAcquisitionLeaseCount: 0,
    liveWorkReceiptLeaseCount: 0,
    liveEnrichmentLeaseCount: 0,
    liveSegmentLeaseCount: 0,
    segments: [0, 1].map((segmentOrdinal) => ({
      segmentOrdinal,
      firstOrdinal: segmentOrdinal * 25,
      lastOrdinal: segmentOrdinal * 25 + 24,
      itemCount: 25,
      status: 'processed',
      processingOffset: 25,
      insertedCount: 20,
      duplicateCount: 3,
      filteredCount: 2,
      processingErrorCount: 0,
    })),
    ...overrides,
  };
}

test('v2 rollout paths remain disabled when the test environment supplies no activation flags', () => {
  assert.equal(ATS_ACQUISITION_V2_ENABLED, false);
  assert.equal(ATS_ACQUISITION_V2_SHADOW_ENABLED, false);
  assert.equal(ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED, false);
});

test('the production activation keeps legacy work until drain and then transfers its board', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const loop = source('src/lib/atsAcquisitionLoop.ts');
  const activation = source('scripts/activate_ats_acquisition_v2.ts');
  assert.match(dispatcher, /promoteDrainedLegacyBoardsToV2/);
  assert.match(dispatcher, /checkAttempts:\s*\{ none:\s*\{ outcome: 'running' \} \}/);
  for (const status of ['fetching', 'partial', 'synchronized', 'queued', 'processing']) {
    assert.match(dispatcher, new RegExp(`'${status}'`));
  }
  assert.match(loop, /await promoteDrainedLegacyBoardsToV2\(\)/);
  assert.match(activation, /unsafeV2Boards/);
});

test('v2 runtime flags require an explicitly activated writer-3 authority gate', () => {
  const dormant = {
    minimumWriterVersion: 1,
    compatibilityWriterVersion: 2,
    v2AuthorityActivatedAt: null,
    activatedLedgerVersion: null,
  };
  assert.equal(validateAtsV2AuthorityActive(dormant).valid, false);
  assert.deepEqual(validateAtsV2AuthorityActive({
    minimumWriterVersion: 3,
    compatibilityWriterVersion: 3,
    v2AuthorityActivatedAt: new Date('2026-08-30T22:00:00.000Z'),
    activatedLedgerVersion: 2,
  }), { valid: true });
});

test('ledger hashing is canonical and sensitive to occurrence multiplicity', () => {
  assert.equal(atsLedgerHash({ b: 2, a: 1 }), atsLedgerHash({ a: 1, b: 2 }));
  assert.notEqual(atsLedgerHash(['job-a']), atsLedgerHash(['job-a', 'job-a']));
  assert.notEqual(atsLedgerHash({ jobs: [{ id: 'a' }] }), atsLedgerHash({ jobs: [{ id: 'b' }] }));
});

test('daily contact authority assigns the confirmed instant to the Chicago day', () => {
  assert.equal(
    chicagoLocalDay(new Date('2026-08-30T04:59:59.000Z')).toISOString(),
    '2026-08-29T00:00:00.000Z',
  );
  assert.equal(
    chicagoLocalDay(new Date('2026-08-30T05:00:00.000Z')).toISOString(),
    '2026-08-30T00:00:00.000Z',
  );
});

test('finish-fast lane planning reserves one continuation slot while coverage remains', () => {
  const late = planAtsV2LaneReservation({
    confirmedContacts: 1_000,
    targetContacts: 6_200,
    elapsedDayFraction: 0.75,
    remainingDayMs: 6 * 60 * 60_000,
    observedCoverageQuantumMs: 30_000,
    coverageEligible: 10_000,
    continuationEligible: 100,
  });
  assert.equal(late.coverageSlots, 3);
  assert.equal(late.continuationSlots, 1);
  assert.equal(late.requiredByNow, 6_200);
  assert.equal(late.reason, 'coverage_target_remaining');

  const balanced = planAtsV2LaneReservation({
    confirmedContacts: 3_100,
    targetContacts: 6_200,
    elapsedDayFraction: 0.5,
    remainingDayMs: 12 * 60 * 60_000,
    observedCoverageQuantumMs: 5_000,
    coverageEligible: 10_000,
    continuationEligible: 100,
  });
  assert.equal(balanced.coverageSlots, 3);
  assert.equal(balanced.continuationSlots, 1);
  assert.equal(balanced.reason, 'coverage_target_remaining');
});

test('the daily coverage goal does not cap eligible catch-up and recovery work', () => {
  const goalMet = planAtsV2LaneReservation({
    confirmedContacts: 6_200,
    targetContacts: 6_200,
    elapsedDayFraction: 0.5,
    coverageEligible: 10_000,
    continuationEligible: 100,
  });
  assert.equal(goalMet.requiredByNow, 6_200);
  assert.equal(goalMet.coverageDebt, 0);
  assert.equal(goalMet.coverageSlots, 3);
  assert.equal(goalMet.continuationSlots, 1);
  assert.equal(goalMet.reason, 'coverage_goal_met');

  const spareCapacity = planAtsV2LaneReservation({
    confirmedContacts: 7_500,
    targetContacts: 6_200,
    elapsedDayFraction: 0.75,
    coverageEligible: 500,
    continuationEligible: 0,
  });
  assert.equal(spareCapacity.coverageDebt, 0);
  assert.equal(spareCapacity.coverageSlots, 4);
  assert.equal(spareCapacity.continuationSlots, 0);
  assert.equal(spareCapacity.reason, 'continuation_idle_loan');
});

test('v2 coverage spends excess capacity in assigned, overdue, recovery order', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const selection = dispatcher.slice(
    dispatcher.indexOf('export async function selectNextAtsV2CoverageBoard'),
    dispatcher.indexOf('export async function claimNextAtsV2Coverage'),
  );
  const assigned = selection.indexOf('checkDay: today');
  const overdue = selection.indexOf('checkDay: { not: today }');
  const recovery = selection.indexOf('ATS_RECOVERY_STATUSES');
  assert.ok(assigned > 0 && overdue > assigned && recovery > overdue);
});

test('idle lanes lend capacity without freezing eligible work', () => {
  assert.deepEqual(
    planAtsV2LaneReservation({
      confirmedContacts: 0,
      elapsedDayFraction: 0.5,
      coverageEligible: 0,
      continuationEligible: 10,
    }),
    {
      totalSlots: 4,
      coverageSlots: 0,
      continuationSlots: 4,
      requiredByNow: 6_200,
      coverageDebt: 6_200,
      projectedContacts: 5_760,
      reason: 'coverage_idle_loan',
    },
  );
  const coverageOnly = planAtsV2LaneReservation({
    confirmedContacts: 0,
    elapsedDayFraction: 0,
    coverageEligible: 10,
    continuationEligible: 0,
  });
  assert.equal(coverageOnly.coverageSlots, 4);
  assert.equal(coverageOnly.continuationSlots, 0);
});

test('continuation ordering round-robins platform and phase before a second peer claim', () => {
  const date = (value: string) => new Date(value);
  const selected = orderAtsV2ContinuationCandidates([
    { id: 'w-old', platform: 'workday', acquisitionPhase: 'listing', lastServedAt: date('2026-08-30T00:00:00Z'), nextAcquireAt: null },
    { id: 'w-new', platform: 'workday', acquisitionPhase: 'listing', lastServedAt: date('2026-08-30T01:00:00Z'), nextAcquireAt: null },
    { id: 's-one', platform: 'smartrecruiters', acquisitionPhase: 'listing', lastServedAt: date('2026-08-30T02:00:00Z'), nextAcquireAt: null },
    { id: 'w-enrich', platform: 'workday', acquisitionPhase: 'enrichment', lastServedAt: date('2026-08-30T03:00:00Z'), nextAcquireAt: null },
  ], 4);
  assert.deepEqual(selected.slice(0, 3).map((row) => row.id), ['s-one', 'w-enrich', 'w-old']);
  assert.equal(selected[3].id, 'w-new');
});

test('pagination fails closed on a short page before the provider total', () => {
  assert.deepEqual(planAtsV2PageCompletion({
    platform: 'workday',
    requestedOffset: 20,
    responseCount: 5,
    providerTotal: 100,
  }), {
    listingComplete: false,
    anomaly: 'ATS workday returned a short page before its reported total.',
  });
  assert.deepEqual(planAtsV2PageCompletion({
    platform: 'workday',
    requestedOffset: 80,
    responseCount: 20,
    providerTotal: 100,
  }), { listingComplete: true, anomaly: null });
  assert.deepEqual(planAtsV2PageCompletion({
    platform: 'greenhouse',
    requestedOffset: 0,
    responseCount: 4,
    providerTotal: null,
  }), { listingComplete: true, anomaly: null });
});

test('v2 progress writes are row-granular and segment publication is credit-fenced', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const route = source('src/app/api/pipeline/run/route.ts');
  const worker = source('scripts/workers/ats-acquisition.ts');
  const migration = source('prisma/migrations/20260830213000_ats_acquisition_ledger_phase2_runtime/migration.sql');
  assert.match(ledger, /atsIngestionPage\.create/);
  assert.match(ledger, /atsListingObservation\.createMany/);
  assert.match(ledger, /atsIngestionItem\.createMany/);
  assert.match(ledger, /atsIngestionSegment\.create/);
  assert.doesNotMatch(ledger, /payload:\s*jobs/);
  assert.match(ledger, /pg_advisory_xact_lock/);
  assert.match(ledger, /publicationPaused/);
  assert.match(dispatcher, /runAtsV2ContinuousPublisher/);
  assert.match(route, /runAtsV2ContinuousPublisher/);
  assert.match(route, /superviseLoop\('ATS Segment Publication', runAtsSegmentPublicationLoop\)/);
  assert.doesNotMatch(worker, /runAtsV2ContinuousPublisher/);
  assert.match(dispatcher, /maxSegments: ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION/);
  // A publication pass must commit inside the ledger transaction timeout. Ten
  // segments per pass could not, so every pass rolled back and the sealed
  // backlog never drained. The cap stays bounded at 10 and defaults lower.
  assert.match(dispatcher, /ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION = Math\.max\(1, Math\.min\(/);
  assert.match(dispatcher, /ATS_V2_PUBLICATION_MAX_SEGMENTS/);
  assert.equal(ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION <= 10, true);
  assert.equal(ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION >= 1, true);
  // The timeout must exceed one pass of multi-second batch updates.
  assert.match(ledger, /ATS_LEDGER_TRANSACTION_TIMEOUT_MS/);
  assert.doesNotMatch(ledger, /timeout: 30_000/);
  assert.doesNotMatch(dispatcher, /batchId: claim\.batchId/);
  assert.match(dispatcher, /runAtsV2ContinuousDispatcher/);
  assert.match(dispatcher, /await runAtsV2Claim\(claim, input\.signal\)/);
  assert.match(dispatcher, /reconcileExpiredAtsV2Work/);
  assert.match(dispatcher, /input\.onError\?\./);
  assert.match(dispatcher, /await dependencies.recordAtsV2ListingDispatchIntent\(claim, intentAt\);\s+\/\/[\s\S]+?requestStartedAt = intentAt/);
  assert.match(dispatcher, /await dependencies.confirmAtsV2ListingContact\([\s\S]+?contactPersisted = true/);
  assert.match(route, /claimNextAtsV2Segment/);
  assert.match(route, /ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED/);
  assert.match(route, /assertAtsV2AuthorityActive/);
  assert.match(worker, /v2RuntimeAuthorized/);
  assert.match(worker, /assertAtsV2AuthorityActive/);
  assert.match(migration, /guard_ats_ingestion_page_evidence/);
  assert.match(migration, /guard_ats_ingestion_item_evidence/);
  assert.match(migration, /guard_ats_ingestion_segment_manifest/);
  assert.match(migration, /reject_ats_append_only_evidence_change/);
  assert.match(migration, /v2_writer_authorized := COALESCE\(/);
});

test('publication gate polling preserves hysteresis without idle write churn', () => {
  const pauseStartedAt = new Date('2026-08-31T20:00:00.000Z');
  const now = new Date('2026-08-31T20:05:00.000Z');
  assert.deepEqual(planAtsV2PublicationGate({
    previousPaused: false,
    previousPausedAt: null,
    previousBacklogJobs: 0,
    initialBacklogJobs: 0,
    finalBacklogJobs: 0,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    now,
  }), {
    publishAllowed: true,
    publicationPaused: false,
    publicationPausedAt: null,
    publicationBacklogJobs: 0,
    changed: false,
  });
  assert.deepEqual(planAtsV2PublicationGate({
    previousPaused: true,
    previousPausedAt: pauseStartedAt,
    previousBacklogJobs: 1_500,
    initialBacklogJobs: 1_500,
    finalBacklogJobs: 1_500,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    now,
  }), {
    publishAllowed: false,
    publicationPaused: true,
    publicationPausedAt: pauseStartedAt,
    publicationBacklogJobs: 1_500,
    changed: false,
  });
});

test('publication gate timestamps only real pause transitions', () => {
  const pauseStartedAt = new Date('2026-08-31T20:00:00.000Z');
  const now = new Date('2026-08-31T20:05:00.000Z');
  const entered = planAtsV2PublicationGate({
    previousPaused: false,
    previousPausedAt: null,
    previousBacklogJobs: 1_999,
    initialBacklogJobs: 1_999,
    finalBacklogJobs: 2_000,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    now,
  });
  assert.equal(entered.publishAllowed, true);
  assert.equal(entered.publicationPaused, true);
  assert.equal(entered.publicationPausedAt, now);
  assert.equal(entered.changed, true);

  const resumed = planAtsV2PublicationGate({
    previousPaused: true,
    previousPausedAt: pauseStartedAt,
    previousBacklogJobs: 1_001,
    initialBacklogJobs: 1_000,
    finalBacklogJobs: 1_000,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    now,
  });
  assert.equal(resumed.publishAllowed, true);
  assert.equal(resumed.publicationPaused, false);
  assert.equal(resumed.publicationPausedAt, null);

  const resumedAndRefilled = planAtsV2PublicationGate({
    previousPaused: true,
    previousPausedAt: pauseStartedAt,
    previousBacklogJobs: 1_001,
    initialBacklogJobs: 1_000,
    finalBacklogJobs: 2_000,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    now,
  });
  assert.equal(resumedAndRefilled.publishAllowed, true);
  assert.equal(resumedAndRefilled.publicationPaused, true);
  assert.equal(resumedAndRefilled.publicationPausedAt, now);

  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const publisher = ledger.slice(
    ledger.indexOf('export async function publishReadyAtsV2Segments'),
    ledger.indexOf('function mergeAtsLedgerItem'),
  );
  assert.equal((publisher.match(/atsAcquisitionRuntimeGate\.update\(/g) || []).length, 1);
  assert.match(publisher, /if \(gatePlan\.changed\)/);
});

test('sealing is reachable only once every item is terminal', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  // The continuation quantum only terminalizes and enriches in the enrichment
  // phase, and both ledger writers refuse to act unless the batch reads
  // 'enrichment'. Sealing early therefore stranded the batch forever.
  assert.match(dispatcher, /if \(claim\.acquisitionPhase === 'enrichment'\) \{\s+const marked = await terminalizeAtsV2NoNetworkItems/);
  assert.match(ledger, /if \(batch\.acquisitionPhase !== 'enrichment'\) return \{ inspected: 0, terminalized: 0 \};/);
  assert.match(ledger, /if \(batch\.acquisitionPhase !== 'enrichment'\) return null;/);
  assert.match(
    ledger,
    /const allItemsTerminal = batch\.terminalItemCount === batch\.canonicalOccurrenceCount;/,
  );
  assert.match(
    ledger,
    /acquisitionPhase: complete\s+\? 'synchronized'\s+: allItemsTerminal \? 'sealing' : 'enrichment',/,
  );
  assert.doesNotMatch(ledger, /acquisitionPhase: complete \? 'synchronized' : 'sealing'/);
});

test('the continuation lane drains acquired work before it ingests more listings', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  assert.match(ledger, /export const ATS_V2_DRAIN_PHASES = \[/);
  for (const phase of ['compaction', 'enrichment', 'sealing']) {
    assert.match(ledger, new RegExp(`ATS_V2_DRAIN_PHASES = \\[[^\\]]*'${phase}'`));
  }
  for (const phase of ['synchronized', 'publishing']) {
    assert.doesNotMatch(ledger, new RegExp(`ATS_V2_DRAIN_PHASES = \\[[^\\]]*'${phase}'`));
  }
  // Listing is the only continuation phase that adds staging pressure, so it
  // must never appear in the drain set and must only be reached by fallback.
  assert.doesNotMatch(ledger, /ATS_V2_DRAIN_PHASES = \[[^\]]*'listing'/);
  assert.match(
    ledger,
    /acquisitionPhase: \{ in: \[\.\.\.ATS_V2_DRAIN_PHASES\] \},\s*\},\s*orderBy,\s*select: \{ id: true \},\s*\}\) \|\| await prisma\.atsIngestionBatch\.findFirst\(/,
  );
});

test('early processed segments cannot finalize a board with later enrichment remaining', () => {
  const earlySegments = finalizationSnapshot({
    status: 'partial',
    synchronizedAt: null,
    acquisitionPhase: 'enrichment',
    canonicalOccurrenceCount: 500,
    canonicalItemCount: 500,
    terminalItemCount: 100,
    terminalItemRowCount: 100,
    sealedItemCount: 100,
    publishedItemCount: 100,
    segments: finalizationSnapshot().segments,
  });
  assert.equal(atsV2BatchFinalizationReady(earlySegments), false);
});

test('the true final segment completes a fully reconciled board exactly once', () => {
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot()), true);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ status: 'reset_synchronized' })), true);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({
    processedAt: new Date('2026-08-31T20:06:00.000Z'),
    status: 'processed',
  })), false);

  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const finalizer = ledger.slice(
    ledger.indexOf('async function finalizeAtsV2BatchIfReady'),
    ledger.indexOf('export async function completeAtsV2SegmentProcessing'),
  );
  assert.match(
    finalizer,
    /atsIngestionSegment\.findFirst\([\s\S]+?ledgerGeneration: generation,[\s\S]+?status: \{ not: 'processed' \}[\s\S]+?if \(outstandingSegment\) return false;/,
  );
  assert.match(ledger, /status: \{ in: \['synchronized', 'reset_synchronized'\] \},[\s\S]+?processedAt: null,[\s\S]+?finalized\.count !== 1/);
  assert.doesNotMatch(ledger, /remainingSegments === 0/);
});

test('finalization fails closed on evidence gaps, offsets, deferred details, or live leases', () => {
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ resolutionCount: 49 })), false);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ terminalItemCount: 49 })), false);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ rawObservationCount: -1 })), false);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ incompletePageCount: 1 })), false);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ liveAcquisitionLeaseCount: 1 })), false);
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({
    segments: finalizationSnapshot().segments.map((segment, index) => (
      index === 1 ? { ...segment, processingOffset: 24 } : segment
    )),
  })), false);
});

test('lease-expiry reconciliation retries finalization after a synchronized owner crashes', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const reconciliation = ledger.slice(
    ledger.indexOf('export async function reconcileExpiredAtsV2Work'),
    ledger.indexOf('export async function atsV2StagingSnapshot'),
  );
  assert.match(reconciliation, /status: \{ in: \['synchronized', 'reset_synchronized'\] \},[\s\S]+?acquisitionLeaseExpiresAt: \{ lte: now \}/);
  assert.match(reconciliation, /await authorizeAtsV2LifecycleWrite\(transaction\)/);
  assert.match(reconciliation, /await finalizeAtsV2BatchIfReady\(transaction, candidate\.id, now\)/);
  assert.match(reconciliation, /finalizedBatches/);
});

test('publisher and consumer restarts resume from durable segment state', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const publisher = ledger.slice(
    ledger.indexOf('export async function publishReadyAtsV2Segments'),
    ledger.indexOf('function mergeAtsLedgerItem'),
  );
  const consumerClaim = ledger.slice(
    ledger.indexOf('export async function claimNextAtsV2Segment'),
    ledger.indexOf('export async function heartbeatAtsV2Segment'),
  );
  const segmentCompletion = ledger.slice(
    ledger.indexOf('export async function completeAtsV2SegmentProcessing'),
    ledger.indexOf('export async function failAtsV2SegmentProcessing'),
  );

  assert.match(publisher, /status: 'sealed'/);
  assert.match(consumerClaim, /status: 'published'/);
  assert.match(consumerClaim, /status: 'processing', leaseExpiresAt: \{ lte: now \}/);
  const retryRelease = segmentCompletion.slice(
    segmentCompletion.indexOf('if (input.counters.processingErrors > 0'),
    segmentCompletion.indexOf('const nextOffset'),
  );
  assert.match(retryRelease, /processingOffset: segment\.processingOffset/);
  assert.doesNotMatch(retryRelease, /data: \{[\s\S]*?processingOffset:/);
  for (const counter of ['insertedCount', 'duplicateCount', 'filteredCount', 'processingErrorCount']) {
    assert.doesNotMatch(retryRelease, new RegExp(`data: \\{[\\s\\S]*?${counter}:`));
  }
});

test('zero-item and fully compacted boards complete through the same reconciliation guard', () => {
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({
    rawObservationCount: 12,
    observationCount: 12,
    resolutionCount: 12,
    canonicalOccurrenceCount: 0,
    canonicalItemCount: 0,
    compactedOccurrenceCount: 12,
    terminalItemCount: 0,
    terminalItemRowCount: 0,
    sealedItemCount: 0,
    publishedItemCount: 0,
    segments: [],
  })), true);
});

test('quarantined processing errors must still reconcile to the durable segment offset', () => {
  const segments = [...finalizationSnapshot().segments];
  segments[1] = {
    ...segments[1],
    insertedCount: 19,
    processingErrorCount: 1,
  };
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ segments })), true);
  segments[1] = { ...segments[1], insertedCount: 18 };
  assert.equal(atsV2BatchFinalizationReady(finalizationSnapshot({ segments })), false);
});

test('whole-board finalization leaves existing Jobs and scores untouched', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const finalizer = ledger.slice(
    ledger.indexOf('async function finalizeAtsV2BatchIfReady'),
    ledger.indexOf('export async function completeAtsV2SegmentProcessing'),
  );
  assert.match(finalizer, /transaction\.atsIngestionBatch\.updateMany/);
  assert.match(finalizer, /transaction\.atsEndpointSweepReceipt\.updateMany/);
  assert.match(finalizer, /transaction\.atsCompany\.update/);
  assert.doesNotMatch(finalizer, /transaction\.job(?:\.|\b)/i);
  assert.doesNotMatch(finalizer, /score/i);
});

test('v2 can take every acquisition slot once no legacy board rotates', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const loop = source('src/lib/atsAcquisitionLoop.ts');
  const activation = source('scripts/activate_ats_acquisition_v2.ts');
  // The slot ceiling is the shared acquisition concurrency, not a hardcoded 3.
  assert.match(dispatcher, /ATS_ACQUISITION_V2_SLOT_COUNT = Math\.max\(1, Math\.min\(\s*ATS_ACQUISITION_CONCURRENCY,/);
  assert.doesNotMatch(dispatcher, /Math\.min\(3, Math\.floor\(totalSlots\)\)/);
  assert.match(dispatcher, /runAtsV2ContinuousDispatcher[\s\S]*?Math\.min\(\s*ATS_ACQUISITION_CONCURRENCY,/);
  // No mandatory legacy reservation, and a zero-slot legacy lane must select
  // no boards rather than select boards it cannot process.
  assert.match(loop, /Math\.max\(0, ATS_ACQUISITION_CONCURRENCY - ATS_ACQUISITION_V2_SLOT_COUNT\)/);
  assert.match(loop, /const selectionLimit = legacyWorkerSlots > 0 \? ATS_BOARD_BATCH_SIZE : 0;/);
  assert.match(activation, /ATS_ACQUISITION_V2_SLOT_COUNT < 2/);
  // On the M70 the lane count is host configuration in the restricted runtime
  // file, and the dispatcher is driven by the leases actually claimed rather
  // than by that constant, so the ceiling that matters is asserted above.
  const remote = source('scripts/workers/ats-remote-continuation.ts');
  assert.match(remote, /totalSlots: leases\.length/);
});

test('coverage yields its slots whenever acquired work is waiting', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  // Coverage is the only lane that adds staging pressure, so a blocked staging
  // area gives it nothing and a saturated drain queue holds it to one slot.
  assert.match(dispatcher, /const staging = await atsV2StagingSnapshot\(\);/);
  assert.match(dispatcher, /const drainSaturated = shadow\.drainEligible >= slots;/);
  assert.match(dispatcher, /if \(staging\.blocked\) \{[\s\S]*?coverageSlots: 0,[\s\S]*?reason: 'staging_blocked',/);
  assert.match(dispatcher, /Math\.min\(ATS_V2_COVERAGE_SLOTS_WHILE_DRAINING, slots - 1\)/);
  assert.match(dispatcher, /ATS_V2_COVERAGE_SLOTS_WHILE_DRAINING = 1;/);
  // Drain depth must exclude the one continuation phase that ingests.
  assert.match(dispatcher, /batch\."acquisitionPhase" IN \('compaction', 'enrichment', 'sealing'\)[\s\S]*?AS "drainEligible"/);
});

test('ledger writes retry a serialization failure instead of failing the quantum', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  // Serializable is what makes 40001 an expected outcome rather than a fault,
  // so the retry and the isolation level have to travel together.
  assert.match(ledger, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(ledger, /function runLedgerTransaction<T>\(/);
  assert.match(
    ledger,
    /return withProviderTransactionRetry\(\(\) => prisma\.\$transaction\(run, LEDGER_TRANSACTION_OPTIONS\)\);/,
  );
  // Every ledger write must go through the retry, not straight to $transaction.
  const direct = ledger.match(/prisma\.\$transaction\(async \(transaction\)/g) || [];
  assert.equal(direct.length, 0);
  const wrapped = ledger.match(/runLedgerTransaction\(async \(transaction\)/g) || [];
  assert.equal(wrapped.length, 15);
});

test('a lost admission race stays a lost race rather than becoming a retry', () => {
  const control = source('src/lib/ingestionControl.ts');
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  // P2002 is a genuine unique-constraint loss: admitAtsV2Board returns null.
  // Only P2034 (and the narrow P2028 case) may replay, or that race would be
  // retried into a duplicate admission attempt.
  assert.match(control, /if \(code === 'P2034'\) return true;/);
  assert.match(control, /if \(code !== 'P2028'\) return false;/);
  assert.match(ledger, /if \(isPrismaError\(error, 'P2002'\)\) return null;/);
});

test('a circuit-blocked board sleeps until the circuit reopens, not a flat 15 minutes', () => {
  const now = new Date('2026-09-01T20:00:00.000Z');
  const fallback = new Date('2026-09-01T20:15:00.000Z');
  // An ordinary transient error keeps the bounded retry.
  assert.deepEqual(atsListingRetryAt(new Error('HTTP 500'), now), fallback);
  assert.deepEqual(atsListingRetryAt(null, now), fallback);
  // An open circuit knows when it reopens; honour it instead of churning.
  const reopen = new Date('2026-09-02T01:08:00.000Z');
  assert.deepEqual(
    atsListingRetryAt(Object.assign(new Error('deferred by circuit_open'), { retryAt: reopen }), now),
    reopen,
  );
  // A stale or already-passed reopen must never schedule work in the past.
  assert.deepEqual(
    atsListingRetryAt(
      Object.assign(new Error('x'), { retryAt: new Date('2026-09-01T19:00:00.000Z') }), now),
    fallback,
  );
  assert.deepEqual(
    atsListingRetryAt(Object.assign(new Error('x'), { retryAt: 'soon' }), now),
    fallback,
  );
  // The listing path must not reintroduce a hardcoded flat deferral.
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  assert.match(dispatcher, /nextAcquireAt: atsListingRetryAt\(error\)/);
  assert.doesNotMatch(dispatcher, /nextAcquireAt: new Date\(Date\.now\(\) \+ 15 \* 60_000\)/);
});

test('a demoted board honours its recovery cadence instead of a 15-minute listing loop', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  // Only an already-demoted board is slowed down, and only on a failure.
  assert.match(dispatcher, /ATS_RECOVERY_STATUSES\.includes\(board\.status/);
  assert.match(dispatcher, /outcome\.yieldReason === 'error'/);
  // It must never move a board's status or demote anything itself.
  const helper = dispatcher.slice(
    dispatcher.indexOf('async function recoveryAwareRetryAt'),
    dispatcher.indexOf('export async function runAtsV2Claim'),
  );
  assert.doesNotMatch(helper, /atsCompany\.update|status:\s*'(parked|blacklisted|active)'/);
  // It may only ever push a retry later, never pull one earlier.
  assert.match(helper, /recoveryAt\.getTime\(\) > proposed\.getTime\(\) \? recoveryAt : proposed/);
  // A telemetry failure must not take the claim down with it.
  assert.match(dispatcher, /recoveryAwareRetryAt\(claim, outcome\.nextAcquireAt, outcome\.boardFailure\)\s*\n?\s*\.catch/);
});

test('a request refused inside the pipeline never earns the weekly recovery slot', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const helper = dispatcher.slice(
    dispatcher.indexOf('async function recoveryAwareRetryAt'),
    dispatcher.indexOf('export async function runAtsV2Claim'),
  );
  assert.ok(helper.length > 0);

  // The guard lives inside the function that applies the rule, not at the call
  // site. This rule was got wrong twice in two phases by callers that simply
  // did not apply it; a caller can forget a condition but not an argument.
  // Without it an open circuit parked 4,593 listing batches for ~6.5 days
  // behind circuits due to reopen in six.
  assert.match(helper, /boardFailure: boolean \| undefined/);
  assert.match(helper, /if \(!boardFailure\) return proposed;/);

  // The origin must be supplied by the caller, and isAtsBoardLevelFailure stays
  // the single authority for that judgement, so the rule cannot drift apart
  // from the failure record that shares it.
  assert.match(dispatcher, /recoveryAwareRetryAt\(claim, outcome\.nextAcquireAt, outcome\.boardFailure\)/);
  assert.match(dispatcher, /boardFailure: isAtsBoardLevelFailure\(error\)/);

  // Listing stays the only phase that may reach the rule at all: the drain
  // phases hold postings already in hand, which the board has no part in.
  const decision = dispatcher.slice(
    dispatcher.indexOf('const nextAcquireAt = outcome.yieldReason'),
    dispatcher.indexOf('const retained = await finishAtsV2Claim'),
  );
  assert.match(decision, /claim\.acquisitionPhase === 'listing'/);
});

test('the watchdog can see work stranded on a demoted board, not only an active one', () => {
  const watchdog = source('scripts/ats_pipeline_watchdog.ts');

  // The stranded-work check used to require an active board, while the rule
  // that strands work fires only for parked and blacklisted ones. The two sets
  // were exactly disjoint, so the check could never see the failure it existed
  // to catch: 2,678 batches held on 2026-09-02 were invisible to it.
  assert.match(watchdog, /c\.status = 'active' or \$\{PIPELINE_IMPOSED_SQL\}/);

  // A demoted board whose own request failed keeps its weekly slot, so the
  // second arm must be restricted to failures the pipeline imposed on itself.
  // Same wording as the dispatcher's authority, for the same reason.
  assert.match(watchdog, /deferred by\|circuit_open\|rate\.\?limited this request/);

  // Detection and repair must share one predicate. Written out twice, a repair
  // can quietly stop covering what the check reports.
  const repair = watchdog.slice(watchdog.indexOf('async function repair'));
  assert.match(repair, /and \$\{STRANDED_WORK_SQL\}/);
  assert.equal(watchdog.match(/nextAcquireAt" > now\(\) at time zone 'UTC' \+ interval/g)?.length, 1);

  // A live circuit still explains a deferral: work is never pulled forward into
  // a platform that is currently refusing calls.
  assert.match(watchdog, /p\."openUntil" > now\(\) at time zone 'UTC'\)/);
});

test('the standing pruning review reports and never retires a board', () => {
  const review = source('scripts/review_ats_board_pruning.ts');

  // The whole safety argument for retiring boards on a schedule is that it is
  // not done on a schedule. An excluded board is never re-judged, so the arms
  // are gated behind a hash of the exact list a human reviewed. A timer holding
  // that approval would defeat the only control that makes exclusion safe.
  // --apply may appear only inside the command this prints for a human. What it
  // actually spawns carries no flags at all, so every arm runs in dry-run mode.
  assert.match(review, /\['--import', 'tsx', path\.join\('scripts', arm\.script\)\]/);
  assert.doesNotMatch(review, /'--apply'/);
  assert.match(review, /approvalCommand/);
  assert.match(review, /readOnly: true/);

  // It must not reach for the database itself either: every arm is spawned in
  // its own dry-run mode, so this file cannot grow a write path of its own.
  assert.doesNotMatch(review, /from '\.\.\/src\/lib\/prisma'/);

  // The unit that runs it must not carry the flag that authorises unattended
  // writes, and must not be the watchdog's repair unit by another name.
  const unit = source('scripts/deployment/m70/career-dashboard-board-pruning.service');
  assert.doesNotMatch(unit, /ConditionPathExists=.*watchdog-repair-enabled/);
  const execStart = unit.split('\n').filter((line) => line.startsWith('ExecStart'));
  assert.equal(execStart.length, 1);
  assert.match(execStart[0], /review_ats_board_pruning\.ts$/);
  assert.doesNotMatch(execStart[0], /--repair|--apply/);
});

test('deployment tolerates stopping a unit the running release does not have yet', () => {
  const activate = source('scripts/deployment/activate-m70.sh');

  // Units are installed part-way down this script, but background timers are
  // stopped at the top, under `trap recover ERR`. So on the first release that
  // introduces a unit, stopping it fails with "not loaded" (exit 5) and rolls
  // back a release that was otherwise fine -- which is exactly what happened
  // when the board-pruning timer was added on 2026-09-02.
  //
  // Any newly introduced unit must therefore be stopped tolerantly until a
  // release carrying it has actually shipped.
  const stopLine = activate
    .split('\n')
    .find((line) => line.startsWith('systemctl stop career-dashboard-board-pruning.timer'));
  assert.ok(stopLine, 'the pruning timer must be stopped before the release swap');
  assert.match(stopLine, /\|\| true$/);

  // The units that predate this hazard stay strict: a failure to stop one of
  // those is a real fault and must still abort the release.
  assert.match(
    activate,
    /^systemctl stop career-dashboard-scheduler\.timer career-dashboard-watchdog\.timer$/m,
  );

  // Restoring afterwards is conditional on the timer having been active before,
  // so a release never enables a unit the operator had deliberately stopped.
  assert.match(activate, /\(\( PRUNING == 0 \)\) \|\| systemctl start career-dashboard-board-pruning\.timer/);
});

test('a continuation quantum that makes no progress backs off instead of respinning', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const quantum = dispatcher.slice(
    dispatcher.indexOf('async function runAtsV2ContinuationQuantum'),
    dispatcher.indexOf('async function recoveryAwareRetryAt'),
  );
  assert.ok(quantum.length > 0);

  // Progress is what keeps a batch instantly eligible, so a draining board is
  // never slowed by the backoff. All three sources of progress count.
  assert.match(quantum, /if \(marked\.terminalized > 0\) progressed = true;/);
  assert.match(quantum, /if \(result === 'terminal'\) progressed = true;/);
  assert.match(quantum, /if \(sealed\.sealedSegments > 0\) progressed = true;/);

  // An idle enrichment yield must carry a retry time. Without one
  // finishAtsV2Claim leaves the batch eligible now and the dispatcher reclaims
  // it on the very next pass, which is what saturated all eight lanes with
  // 73,664 no-op claims on 2026-09-01 while 4,641 listing batches waited.
  assert.match(
    quantum,
    /\.\.\.\(progressed\s*\?\s*\{\}\s*:\s*\{ nextAcquireAt: new Date\(Date\.now\(\) \+ ATS_V2_CONTINUATION_IDLE_RETRY_MS\) \}\)/,
  );
  // The completion path stays immediate: sealing done is not a backoff case.
  assert.match(quantum, /if \(sealed\.complete\) return \{ yieldReason: 'segments_sealed' \};/);
  assert.equal(ATS_V2_CONTINUATION_IDLE_RETRY_MS, 60_000);
});

test('a v2 listing failure ages the board without demoting it', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const helper = dispatcher.slice(dispatcher.indexOf('async function recordAtsV2BoardListingFailure'));

  // The board must actually be aged. v2 previously reset failCount on success
  // and never incremented it, so a board that failed kept failCount 0 and fell
  // back to its weekly slot with nothing escalating the retry.
  assert.match(helper, /retryCount: schedule\.retryCount/);
  assert.match(helper, /failCount: schedule\.failCount/);
  assert.match(helper, /nextCheckDate: schedule\.nextCheckDate/);

  // Demotion is allowed, but only on failures spread across separate days.
  // Three failures inside one incident is what a broken pipeline looks like,
  // not a bad board: one misclassified error closed BambooHR and Workday for
  // six hours each and demoted 3,780 boards in a day, against 31 in the two
  // days before. A burst must never be able to demote.
  assert.match(helper, /demoting && confirmed \? \{ status: schedule\.status \}/);
  assert.match(helper, /boardFailedOnDistinctDays/);
  assert.match(helper, /count\(distinct date_trunc\('day', w\."startedAt"\)\)/);
  // The evidence must exclude failures the pipeline imposed on itself, or an
  // outage supplies the proof used to demote the boards it took offline.
  assert.match(helper, /deferred by\|circuit_open\|rate\.\?limited this request/);

  // An excluded board must never be rescheduled back into the rotation.
  assert.match(helper, /ATS_SCHEDULABLE_STATUSES\.includes\(board\.status\)/);

  // Only the board's own failures count. A circuit block or platform pause is
  // the pipeline's back-pressure and must not age a healthy board.
  assert.match(dispatcher, /outcome\.boardFailure && claim\.acquisitionPhase === 'listing'/);
  assert.match(dispatcher, /boardFailure: isAtsBoardLevelFailure\(error\)/);
});

test('a running claim renews its lease so a slow quantum is not mistaken for a dead one', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const ledger = source('src/lib/atsAcquisitionLedger.ts');

  // The lease detects a worker that died. Without renewal it cannot tell that
  // from one that is merely slow, and a quantum outrunning its lease has the
  // batch stolen by another lane: the fence moves and the finish is rejected as
  // "lost its release fence", discarding work that had actually completed.
  //
  // heartbeatAtsV2Claim was written for exactly this and had no caller at all.
  // On 2026-09-03, 51 of 87 finished claims in half an hour ran past the 180s
  // lease averaging 149s, because a throttled platform makes a quantum wait
  // rather than work. Nothing reached `processed` for six and a half hours.
  assert.match(ledger, /export async function heartbeatAtsV2Claim/);
  const run = dispatcher.slice(
    dispatcher.indexOf('export async function runAtsV2Claim'),
    dispatcher.indexOf('export type AtsV2DispatcherProgress'),
  );
  assert.ok(run.length > 0);
  assert.match(run, /setInterval\(/);
  assert.match(run, /heartbeatAtsV2Claim\(claim\)/);

  // It must never fail the quantum, and must always be stopped before the
  // finish settles the claim.
  assert.match(run, /heartbeatAtsV2Claim\(claim\)\s*\n?\s*\.catch\(\(\) => undefined\)/);
  assert.match(run, /finally \{[\s\S]*clearInterval\(heartbeat\)/);

  // Renewal has to be frequent enough to keep more than one attempt in hand
  // before the lease expires, or a single slow round trip still loses it.
  assert.ok(ATS_V2_CLAIM_HEARTBEAT_MS * 2 <= ATS_LEDGER_WORK_LEASE_MS);
  assert.equal(ATS_V2_CLAIM_HEARTBEAT_MS, Math.max(15_000, Math.floor(ATS_LEDGER_WORK_LEASE_MS / 3)));
});
