import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  nextAtsInternalControlRetryAt,
  ATS_ENRICHMENT_CHECKPOINT_ITEMS,
  atsResumeSelectionLimit,
  planAtsSelectionCapacity,
} from '../atsAcquisition';
import { validateAtsAcquisitionWriterCompatibility } from '../atsAcquisitionCompatibility';

const repositoryFile = (relativePath: string) => (
  readFileSync(path.join(process.cwd(), relativePath), 'utf8')
);

test('resumptions hold a bounded share of a turn, and the whole turn under backpressure', () => {
  // Continuations used to be able to take every slot in a turn. A board mid-
  // enrichment costs tens of seconds per attempt against about nine for a fresh
  // board, so that let a few hundred large boards set both the length and the
  // composition of every turn and capped new-board throughput well under the
  // 6,200/day rotation target. Resumption still goes first and still reclaims
  // any slot the new-board tiers cannot use; it just no longer starts by owning
  // all of them.
  assert.deepEqual(planAtsSelectionCapacity({
    selectionLimit: 25,
    resumedCount: 25,
    outstandingCount: 25,
  }), {
    resumeLimit: 9,
    newBatchLimit: 0,
  });
  // Under backpressure no new board may start, so there is no new-board
  // throughput to protect and draining durable payloads is the only way out.
  assert.equal(atsResumeSelectionLimit(25, false), 25);
  // A turn always keeps at least one slot for resumption.
  assert.equal(atsResumeSelectionLimit(2, true), 1);
  assert.equal(atsResumeSelectionLimit(0, true), 0);
});

test('legacy characterization: page and item checkpoints still replace the accumulated payload', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  const acquisition = source.slice(
    source.indexOf('export async function acquireAtsBoardBatch'),
    source.indexOf('const dueOrder'),
  );
  assert.ok(
    (acquisition.match(/payload: jobs as Prisma\.InputJsonValue/g) || []).length >= 3,
    'Phase 0/1 must keep the legacy whole-payload writer visible until v2 primitives replace it',
  );
});

test('enrichment amortizes the payload rewrite without letting the cursor outrun it', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  const enrichment = source.slice(
    source.indexOf('const enrichmentLimit = planAtsEnrichmentChunk'),
    source.indexOf('const readiness = validateAtsEnrichmentQueueReadiness'),
  );
  // The cheap per-item path proves lease ownership and must not carry payload.
  const heartbeat = enrichment.slice(
    enrichment.indexOf("transactionPhase: 'item_heartbeat'"),
    enrichment.indexOf("transactionPhase: 'item_checkpoint'"),
  );
  assert.ok(heartbeat.length > 0, 'the per-item lease heartbeat is missing');
  assert.doesNotMatch(heartbeat, /payload:/);
  assert.match(heartbeat, /AtsAttemptLeaseLostError/);
  // The payload and the cursor that claims it advance in the same transaction,
  // so a durable cursor can never name an item the durable payload lacks.
  const checkpoint = enrichment.slice(enrichment.indexOf("transactionPhase: 'item_checkpoint'"));
  assert.match(checkpoint, /payload: jobs as Prisma\.InputJsonValue/);
  assert.match(checkpoint, /cursor: checkpointCursor as unknown as Prisma\.InputJsonValue/);
  // The end of a chunk always forces a checkpoint, so durable state at an
  // attempt boundary is exactly what the per-item writer used to leave.
  assert.match(
    enrichment,
    /unflushedEnrichedItems >= ATS_ENRICHMENT_CHECKPOINT_ITEMS\s*\|\|\s*cursor\.enrichmentOffset >= enrichmentLimit/,
  );
  assert.match(source, /if \(unflushedEnrichedItems > 0\) \{/);
});

test('the enrichment checkpoint interval is bounded and reverts to per-item writes at 1', () => {
  assert.equal(ATS_ENRICHMENT_CHECKPOINT_ITEMS >= 1, true);
  assert.equal(ATS_ENRICHMENT_CHECKPOINT_ITEMS <= 100, true);
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  assert.match(
    source,
    /ATS_ENRICHMENT_CHECKPOINT_ITEMS = boundedInteger\(\s*process\.env\.ATS_ENRICHMENT_CHECKPOINT_ITEMS, 25, 1, 100,/,
  );
});

test('legacy characterization: detail requests still share the claim-contact callbacks', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  const enrichment = source.slice(
    source.indexOf('const enrichmentLimit = planAtsEnrichmentChunk'),
    source.indexOf('const readiness = validateAtsEnrichmentQueueReadiness'),
  );
  assert.match(enrichment, /onRequestStarted/);
  assert.match(enrichment, /onResponseReceived/);
});

test('legacy characterization: pagination freezes the first total and accepts a short page', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  const listing = source.slice(
    source.indexOf('let listingComplete: boolean;'),
    source.indexOf('if (!cursor.listingComplete)'),
  );
  assert.match(listing, /cursor\.total \?\? result\.total/);
  assert.match(listing, /result\.jobs\.length < pageSize/);
});

test('Phase 0B explicitly bounds marker transactions and isolates internal failures', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  assert.match(source, /const ATS_MARKER_TRANSACTION_OPTIONS = \{/);
  assert.match(source, /transactionPhase: 'request_marker'/);
  assert.match(source, /transactionPhase: 'response_marker'/);
  assert.match(source, /failureScope: 'internal_control'/);
  assert.match(source, /nextAtsInternalControlRetryAt/);
  assert.match(
    source,
    /!internalControl && !throttled && !deferred && providerWideError\(error\)/,
  );
});

test('Phase 0B internal-control retries are short, bounded, and deterministic', () => {
  const now = new Date('2026-08-30T16:00:00.000Z');
  const first = nextAtsInternalControlRetryAt(now, 'attempt-123');
  const second = nextAtsInternalControlRetryAt(now, 'attempt-123');
  const delay = first.getTime() - now.getTime();
  assert.equal(first.toISOString(), second.toISOString());
  assert.ok(delay >= 60_000);
  assert.ok(delay <= 75_000);
});

test('Phase 1 schema is additive and contains every dormant ledger authority', () => {
  const migrationPath = path.join(
    process.cwd(),
    'prisma/migrations/20260830170000_ats_acquisition_ledger_phase1/migration.sql',
  );
  assert.equal(existsSync(migrationPath), true, 'the additive Phase 1 migration must exist');
  const migration = readFileSync(migrationPath, 'utf8');
  const schema = repositoryFile('prisma/schema.prisma');

  for (const model of [
    'AtsIngestionPage',
    'AtsListingObservation',
    'AtsListingObservationResolution',
    'AtsIngestionItem',
    'AtsAcquisitionWorkReceipt',
    'AtsEndpointSweepReceipt',
    'AtsEndpointDailyContactReceipt',
    'AtsIngestionSegment',
    'AtsAcquisitionRuntimeGate',
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`), model);
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`), model);
  }

  for (const retained of ['payload', 'metadata', 'cursor', 'payloadHash']) {
    assert.match(schema, new RegExp(`\\s${retained}\\s`), `legacy ${retained} remains in Prisma`);
  }
  assert.doesNotMatch(migration, /^\s*(?:DROP|DELETE|TRUNCATE)\b/im);
  assert.match(migration, /AtsIngestionSegment_no_overlap/);
  assert.match(migration, /AtsIngestionSegment_bounds_check/);
  assert.match(migration, /CREATE FUNCTION "guard_legacy_ats_batch_write"/);
  assert.match(migration, /CREATE FUNCTION "guard_legacy_ats_attempt_write"/);
  assert.match(migration, /CREATE FUNCTION "claim_ats_batch_for_v2_conversion"/);
});

test('Phase 1 keeps every legacy persistence claim and lease write out of v2 batches', () => {
  const source = repositoryFile('src/lib/atsAcquisition.ts');
  const persistence = source.slice(source.indexOf('export async function atsQueueDepth'));
  assert.match(persistence, /claimNextAtsIngestionBatch[\s\S]+?writerMode: 'legacy'/);
  assert.ok(
    (persistence.match(/writerMode: 'legacy'/g) || []).length >= 11,
    'legacy queue depth, claims, heartbeats, retries, and completions must all fence on writerMode',
  );
});

test('Phase 1 compatibility gate is checked by the acquisition child before work', () => {
  const compatibility = repositoryFile('src/lib/atsAcquisitionCompatibility.ts');
  const worker = repositoryFile('scripts/workers/ats-acquisition.ts');
  const deploy = repositoryFile('scripts/deploy.sh');
  assert.match(compatibility, /ATS_ACQUISITION_WRITER_VERSION/);
  assert.match(compatibility, /assertAtsAcquisitionWriterCompatibility/);
  assert.match(worker, /assertAtsAcquisitionWriterCompatibility\(\)/);
  assert.match(deploy, /verify_ats_acquisition_runtime_compatibility\.ts/);
});

test('Phase 1 runtime gate rejects missing and obsolete writers', () => {
  assert.equal(validateAtsAcquisitionWriterCompatibility(null).valid, false);
  const dormantGate = {
    minimumWriterVersion: 1,
    compatibilityWriterVersion: 2,
    v2AuthorityActivatedAt: null,
    activatedLedgerVersion: null,
  };
  assert.deepEqual(validateAtsAcquisitionWriterCompatibility(dormantGate, 1), { valid: true });
  assert.equal(validateAtsAcquisitionWriterCompatibility({
    ...dormantGate,
    minimumWriterVersion: 2,
    compatibilityWriterVersion: 2,
  }, 1).valid, false);
  assert.equal(validateAtsAcquisitionWriterCompatibility({
    ...dormantGate,
    v2AuthorityActivatedAt: new Date('2026-08-30T16:00:00.000Z'),
    activatedLedgerVersion: 2,
  }, 1).valid, false);
});

test('Stats keeps the legacy claim-contact series and labels the exact v2 series separately', () => {
  const route = repositoryFile('src/app/api/stats/route.ts');
  const contract = repositoryFile('src/lib/statsClientContract.ts');
  assert.match(route, /legacyClaimContactedToday/);
  assert.match(route, /newCycleListingContactedToday/);
  assert.match(route, /contactMetricEffectiveAt/);
  const exactContactRead = route.indexOf('const atsExactContactRows = atsLedgerTelemetryAvailable');
  const operationalFanout = route.indexOf('const basicQueries = prisma.$transaction');
  assert.ok(exactContactRead >= 0, 'stats must load exact contact telemetry');
  assert.ok(
    operationalFanout > exactContactRead,
    'exact contact telemetry must complete before the pool-owned operational snapshot',
  );
  assert.match(
    route.slice(exactContactRead, operationalFanout),
    /\? await prisma\.\$queryRaw/,
    'exact contact telemetry must be awaited rather than added to the nested Promise.all',
  );
  assert.match(contract, /legacyClaimContactedToday/);
  assert.match(contract, /newCycleListingContactedToday/);
});
