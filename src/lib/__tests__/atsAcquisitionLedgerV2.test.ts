import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_V2_ENABLED,
  ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED,
  ATS_ACQUISITION_V2_SHADOW_ENABLED,
  ATS_V2_CONTINUATION_IDLE_RETRY_MS,
  ATS_V2_PUBLICATION_MAX_SEGMENTS_PER_ITERATION,
  atsListingRetryAt,
  orderAtsV2ContinuationCandidates,
  planAtsV2LaneReservation,
  planAtsV2PageCompletion,
} from '../atsAcquisitionDispatcherV2';
import {
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
  assert.match(dispatcher, /await recordAtsV2ListingDispatchIntent\(claim, intentAt\);\s+\/\/[\s\S]+?requestStartedAt = intentAt/);
  assert.match(dispatcher, /await confirmAtsV2ListingContact\([\s\S]+?contactPersisted = true/);
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
  const deploy = source('scripts/deploy.sh');
  // The slot ceiling is the shared acquisition concurrency, not a hardcoded 3.
  assert.match(dispatcher, /ATS_ACQUISITION_V2_SLOT_COUNT = Math\.max\(1, Math\.min\(\s*ATS_ACQUISITION_CONCURRENCY,/);
  assert.doesNotMatch(dispatcher, /Math\.min\(3, Math\.floor\(totalSlots\)\)/);
  assert.match(dispatcher, /runAtsV2ContinuousDispatcher[\s\S]*?Math\.min\(\s*ATS_ACQUISITION_CONCURRENCY,/);
  // No mandatory legacy reservation, and a zero-slot legacy lane must select
  // no boards rather than select boards it cannot process.
  assert.match(loop, /Math\.max\(0, ATS_ACQUISITION_CONCURRENCY - ATS_ACQUISITION_V2_SLOT_COUNT\)/);
  assert.match(loop, /const selectionLimit = legacyWorkerSlots > 0 \? ATS_BOARD_BATCH_SIZE : 0;/);
  assert.match(activation, /ATS_ACQUISITION_V2_SLOT_COUNT < 2/);
  assert.match(deploy, /'ATS_ACQUISITION_LEDGER_V2_SLOTS=4' >> "\$rollout_env_tmp"/);
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
  assert.match(dispatcher, /recoveryAwareRetryAt\(claim, outcome\.nextAcquireAt\)\.catch/);
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
