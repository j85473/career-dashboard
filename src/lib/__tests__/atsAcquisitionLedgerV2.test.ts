import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_V2_ENABLED,
  ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED,
  ATS_ACQUISITION_V2_SHADOW_ENABLED,
  orderAtsV2ContinuationCandidates,
  planAtsV2LaneReservation,
  planAtsV2PageCompletion,
} from '../atsAcquisitionDispatcherV2';
import { atsLedgerHash, chicagoLocalDay } from '../atsAcquisitionLedger';
import { validateAtsV2AuthorityActive } from '../atsAcquisitionCompatibility';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

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

test('elastic lane planning reserves continuation while coverage is behind', () => {
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
  assert.equal(late.reason, 'projected_late');

  const balanced = planAtsV2LaneReservation({
    confirmedContacts: 3_100,
    targetContacts: 6_200,
    elapsedDayFraction: 0.5,
    remainingDayMs: 12 * 60 * 60_000,
    observedCoverageQuantumMs: 5_000,
    coverageEligible: 10_000,
    continuationEligible: 100,
  });
  assert.equal(balanced.coverageSlots, 2);
  assert.equal(balanced.continuationSlots, 2);
});

test('coverage capacity is lent to continuation when the bounded catch-up burst is ahead of pace', () => {
  const paced = planAtsV2LaneReservation({
    confirmedContacts: 4_000,
    targetContacts: 6_200,
    elapsedDayFraction: 0.5,
    coverageEligible: 10_000,
    continuationEligible: 100,
  });
  assert.equal(paced.requiredByNow, 3_100);
  assert.equal(paced.coverageSlots, 0);
  assert.equal(paced.continuationSlots, 4);
  assert.equal(paced.reason, 'coverage_paced');
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
      requiredByNow: 3_100,
      coverageDebt: 3_100,
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
  assert.match(ledger, /processedWithoutSegments/);
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

test('sealing is reachable only once every item is terminal', () => {
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  // The continuation quantum only terminalizes and enriches in the enrichment
  // phase, and both ledger writers refuse to act unless the batch reads
  // 'enrichment'. Sealing early therefore stranded the batch forever.
  assert.match(dispatcher, /if \(claim\.acquisitionPhase === 'enrichment'\) \{\s+await terminalizeAtsV2NoNetworkItems/);
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
  for (const phase of ['compaction', 'enrichment', 'sealing', 'synchronized', 'publishing']) {
    assert.match(ledger, new RegExp(`ATS_V2_DRAIN_PHASES = \\[[^\\]]*'${phase}'`));
  }
  // Listing is the only continuation phase that adds staging pressure, so it
  // must never appear in the drain set and must only be reached by fallback.
  assert.doesNotMatch(ledger, /ATS_V2_DRAIN_PHASES = \[[^\]]*'listing'/);
  assert.match(
    ledger,
    /acquisitionPhase: \{ in: \[\.\.\.ATS_V2_DRAIN_PHASES\] \},\s*\},\s*orderBy,\s*select: \{ id: true \},\s*\}\) \|\| await prisma\.atsIngestionBatch\.findFirst\(/,
  );
});

test('v2 can take every acquisition slot once no legacy board rotates', () => {
  const dispatcher = source('src/lib/atsAcquisitionDispatcherV2.ts');
  const loop = source('src/lib/atsAcquisitionLoop.ts');
  const activation = source('scripts/activate_ats_acquisition_v2.ts');
  const deploy = source('scripts/deploy.sh');
  // The slot ceiling is the shared acquisition concurrency, not a hardcoded 3.
  assert.match(dispatcher, /ATS_ACQUISITION_V2_SLOT_COUNT = Math\.max\(1, Math\.min\(\s*ATS_ACQUISITION_CONCURRENCY,/);
  assert.doesNotMatch(dispatcher, /Math\.min\(3, Math\.floor\(totalSlots\)\)/);
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
  assert.match(dispatcher, /batch\."acquisitionPhase" <> 'listing'[\s\S]*?AS "drainEligible"/);
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
