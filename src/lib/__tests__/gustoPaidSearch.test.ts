import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { claimNextAtsV2Continuation } from '../atsAcquisitionLedger';
import { planAtsTaskModeTransition, type AtsTaskModeRow } from '../atsTaskMode';
import { buildIngestionTaskKey } from '../ingestionControl';
import { canonicalIngestionTaskDefinitions, GUSTO_PAID_SEARCH_TASK_DEFINITION } from '../ingestionTaskCatalog';
import { emptyGustoApiBatchWhere, gustoApiHandoffCandidatesSql, gustoApiHandoffGuardSql, formatGustoPaidSearchTelemetry, reconcileGustoApiBatches } from '../gustoPaidSearch';
import { pipelineStatusRows } from '../pipelineTelemetry';
import { prisma } from '../prisma';

test('Gusto has one paid browser task and never becomes a legacy ATS task', () => {
  const definitions = canonicalIngestionTaskDefinitions({ atsPlatforms: ['gusto', 'workday'] });
  const gusto = definitions.filter((definition) => definition.spec.source === 'Gusto');
  assert.deepEqual(gusto, [GUSTO_PAID_SEARCH_TASK_DEFINITION]);
  assert.equal(gusto[0].spec.ingestionMode, 'paid-browser');
  assert.equal(definitions.some((definition) => definition.spec.source === 'ATS-gusto'), false);
  const old: AtsTaskModeRow = {
    id: 'old-gusto', taskKey: buildIngestionTaskKey({ source: 'ATS-gusto', ingestionMode: 'ats', geoLane: 'source_posted_location', queryFamily: 'all' }),
    source: 'ATS-gusto', ingestionMode: 'ats', taskKind: 'search', lifecycleStatus: 'active', retiredAt: null,
    status: 'pending', leaseToken: null, leaseOwner: null, leaseStartedAt: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null,
  };
  for (const splitEnabled of [true, false]) {
    const plan = planAtsTaskModeTransition({ splitEnabled, rows: [old], legacyPlatforms: ['gusto', 'workday'] });
    assert.equal(plan.activate.some((action) => action.spec.source === 'ATS-gusto'), false);
    assert.deepEqual(plan.retire.map((row) => row.id), ['old-gusto']);
  }
});

test('all API continuation selection branches exclude old Gusto batches', async () => {
  const reads: Array<{ where: Prisma.AtsIngestionBatchWhereInput }> = [];
  const client = {
    atsIngestionBatch: {
      findFirst: async (input: { where: Prisma.AtsIngestionBatchWhereInput }) => { reads.push(input); return null; },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'atsIngestionBatch'>;
  assert.equal(await claimNextAtsV2Continuation({ client }), null);
  assert.equal(reads.length, 4);
  for (const read of reads) assert.deepEqual(read.where.platform, { not: 'gusto' });
});

test('routing refuses envelopes with acquired data or live work', () => {
  const where = emptyGustoApiBatchWhere();
  assert.equal(where.platform, 'gusto');
  for (const field of ['jobCount', 'insertedCount', 'processingOffset', 'listingOffset', 'pageCount', 'rawObservationCount', 'canonicalOccurrenceCount', 'compactedOccurrenceCount', 'terminalItemCount', 'sealedItemCount', 'publishedItemCount'] as const) {
    assert.equal(where[field], 0, `${field} must prove there is no acquired work`);
  }
  for (const relation of ['pages', 'observations', 'observationResolutions', 'items', 'segments'] as const) {
    assert.deepEqual(where[relation], { none: {} });
  }
  assert.equal(where.leaseToken, null);
  assert.equal(where.acquisitionClaimToken, null);
  assert.deepEqual(where.workReceipts, { none: { finishedAt: null } });
  assert.deepEqual(where.attempts, { none: { outcome: 'running' } });
});

test('routing keeps audit history and repeats safety checks after locking', async (t) => {
  const statements: Prisma.Sql[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const reads: Array<{ where: Prisma.AtsIngestionBatchWhereInput }> = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      statements.push('text' in query ? query : Prisma.sql(query, ...values));
      return [{ id: 'empty-gusto' }];
    },
    atsIngestionBatch: {
      findMany: async (input: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        reads.push(input);
        return [{ id: 'empty-gusto' }];
      },
    },
    atsEndpointSweepReceipt: {
      updateMany: async (input: Record<string, unknown>) => { writes.push(input); return { count: 1 }; },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await reconcileGustoApiBatches(), 1);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].where.pages, undefined, 'the initial scan must not join historical pages');
  assert.equal(statements.length, 2);
  assert.match(statements[0].text, /FOR UPDATE OF batch SKIP LOCKED/);
  assert.match(statements[1].text, /UPDATE "AtsIngestionBatch" batch/);
  assert.match(statements[1].text, /SET status = 'routed'/);
  assert.doesNotMatch(statements[1].text, /SET[^]*"processedAt" =/);
  assert.ok(statements[1].values.includes('Moved to paid-search browser collection; Gusto has no supported ATS listing API.'));
  for (const query of statements) {
    assert.ok(query.text.includes(gustoApiHandoffGuardSql().text), 'both lock and update must refuse acquired data and live work');
  }
  const sweep = writes[0].data as Record<string, unknown>;
  assert.equal(sweep.state, 'failed');
  assert.equal(sweep.outcome, 'routed_to_paid_search');
  assert.equal(Object.hasOwn(sweep, 'processedAt'), false);
});

test('a protected batch at the front cannot block later empty Gusto batches', async (t) => {
  const reads: Array<{ where: Prisma.AtsIngestionBatchWhereInput }> = [];
  let probes = 0;
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => ++probes === 1 ? [] : [{ id: 'empty-gusto' }],
    atsIngestionBatch: {
      findMany: async (input: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        reads.push(input);
        return [{ id: reads.length === 1 ? 'protected' : 'empty-gusto' }];
      },
    },
    atsEndpointSweepReceipt: { updateMany: async () => ({ count: 1 }) },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await reconcileGustoApiBatches(), 1);
  assert.deepEqual(reads[1].where.id, { gt: 'protected' });
});

test('the correlated SQL retains every no-data and no-live-work guard', () => {
  const query = gustoApiHandoffGuardSql().text;
  const where = emptyGustoApiBatchWhere();
  for (const [field, value] of Object.entries(where)) {
    if (value === 0) assert.ok(query.includes(`batch."${field}" = 0`), field);
    if (value === null) assert.ok(query.includes(`batch."${field}" IS NULL`), field);
  }
  for (const table of ['AtsIngestionPage', 'AtsListingObservation', 'AtsListingObservationResolution', 'AtsIngestionItem', 'AtsIngestionSegment', 'AtsAcquisitionWorkReceipt', 'AtsBoardCheckAttempt']) {
    assert.ok(query.includes(`NOT EXISTS (SELECT 1 FROM "${table}" child WHERE child."batchId" = batch.id`), table);
  }
  assert.match(query, /child\."finishedAt" IS NULL/);
  assert.match(query, /child\.outcome = 'running'/);
  assert.match(query, /payload = 'null'::jsonb OR batch\.payload = '\[\]'::jsonb/);
  assert.throws(() => gustoApiHandoffCandidatesSql([]), /bounded candidate window/);
  assert.throws(() => gustoApiHandoffCandidatesSql(Array(101).fill('id')), /exceeds 100/);
});

test('Gusto browser activity appears with paid search and feeds, outside the API lane', () => {
  const gusto = formatGustoPaidSearchTelemetry({ dueBoards: 928, sweptToday: 154, running: true, lastFailed: false });
  const rows = pipelineStatusRows(`Ingestion: Indeed waiting · ${gusto} | ATS acquisition: idle | Backpressure: idle | ATS processing: idle | Local Scoring: idle | JD Extraction: idle`);
  assert.match(rows[0].value, /Gusto paid search \(browser\): working/);
  assert.match(rows[0].value, /928 boards due · 154 swept today/);
  assert.equal(rows.slice(1).some((row) => row.value.includes('Gusto')), false);
  assert.match(formatGustoPaidSearchTelemetry({ dueBoards: 8, sweptToday: 0, running: false, lastFailed: true }), /awaiting retry/);
});

test('API coverage excludes Gusto while browser jobs retain existing posting provenance', () => {
  const telemetry = readFileSync('src/lib/atsDistributedTelemetry.ts', 'utf8');
  assert.match(telemetry, /board\.platform <> 'gusto'/);
  assert.equal((telemetry.match(/b\.platform <> 'gusto'/g) || []).length, 2);
  const worker = readFileSync('scripts/sweep_gusto_boards.ts', 'utf8');
  assert.match(worker, /const SOURCE = 'Gusto'/);
  assert.match(worker, /const JOB_SOURCE = 'ATS-gusto'/);
  assert.match(worker, /source: JOB_SOURCE/);
  assert.match(worker, /claimDueIngestionTask\(definition\.spec\)/);
  assert.match(worker, /completeIngestionTask/);
});
