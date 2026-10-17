import { NON_API_ATS_PLATFORMS } from '../browserAtsBoards';
import { mockPrismaTransaction } from '../../../tests/helpers/mockPrismaTransaction';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Prisma } from '../prismaClient';
import { claimNextAtsV2Continuation } from '../atsAcquisitionLedger';
import { planAtsTaskModeTransition, type AtsTaskModeRow } from '../atsTaskMode';
import { buildIngestionTaskKey, reconcileIngestionTaskCatalog } from '../ingestionControl';
import { canonicalIngestionTaskDefinitions, GUSTO_BOARD_COLLECTION_TASK_DEFINITION } from '../ingestionTaskCatalog';
import { emptyGustoApiBatchWhere, gustoApiHandoffCandidatesSql, gustoApiHandoffGuardSql, reconcileGustoApiBatches } from '../gustoBoardCollection';
import { formatAtsBoardCollectionTelemetry, readAtsBoardCollectionTelemetry } from '../atsBoardCollectionTelemetry';
import { pipelineStatusRows } from '../pipelineTelemetry';
import { prisma } from '../prisma';

test('Gusto has one board collection task and never becomes a legacy ATS task', () => {
  const definitions = canonicalIngestionTaskDefinitions({ atsPlatforms: ['gusto', 'workday'] });
  const gusto = definitions.filter((definition) => definition.spec.source === 'Gusto');
  assert.deepEqual(gusto, [GUSTO_BOARD_COLLECTION_TASK_DEFINITION]);
  assert.equal(gusto[0].spec.ingestionMode, 'public-board');
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
  // Cohort priority can add reads; every selection branch must retain the exclusion.
  assert.ok(reads.length >= 4);
  for (const read of reads) assert.deepEqual(read.where.platform, { notIn: NON_API_ATS_PLATFORMS });
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
  mockPrismaTransaction(t, prisma, async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await reconcileGustoApiBatches(), 1);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].where.pages, undefined, 'the initial scan must not join historical pages');
  assert.equal(statements.length, 2);
  assert.match(statements[0].text, /FOR UPDATE OF batch SKIP LOCKED/);
  assert.match(statements[1].text, /UPDATE "AtsIngestionBatch" batch/);
  assert.match(statements[1].text, /SET status = 'routed'/);
  assert.doesNotMatch(statements[1].text, /SET[^]*"processedAt" =/);
  assert.ok(statements[1].values.includes('Moved to ATS crawling; Gusto has no supported ATS listing API.'));
  for (const query of statements) {
    assert.ok(query.text.includes(gustoApiHandoffGuardSql().text), 'both lock and update must refuse acquired data and live work');
  }
  const sweep = writes[0].data as Record<string, unknown>;
  assert.equal(sweep.state, 'failed');
  assert.equal(sweep.outcome, 'routed_to_board_collection');
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
  mockPrismaTransaction(t, prisma, async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
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

test('board collection has its own status row, separate from paid sources and API acquisition', () => {
  const boards = formatAtsBoardCollectionTelemetry({ dueBoards: 928, sweptToday: 154, runningSources: ['Gusto', 'paycom'], awaitingRetry: false });
  for (const pressure of ['', ' | Backpressure: idle']) {
    const rows = pipelineStatusRows(`Ingestion: Indeed waiting | ${boards} | ATS acquisition: idle${pressure} | ATS processing: idle | Local Scoring: idle | JD Extraction: idle`);
    assert.equal(rows[0].value, 'Indeed waiting');
    const lane = rows.find((row) => row.id === 'ats-board-collection');
    assert.equal(lane?.label, 'ATS Crawling');
    assert.match(lane!.value, /working \(Gusto, paycom\)/);
    assert.match(lane!.value, /928 boards due · 154 swept today/);
    assert.equal(rows.filter((row) => row.id !== 'ats-board-collection').some((row) => row.value.includes('Gusto')), false);
    assert.equal(rows.find((row) => row.id === 'ats-acquisition')?.value, 'idle');
  }
  assert.match(formatAtsBoardCollectionTelemetry({ dueBoards: 8, sweptToday: 0, runningSources: [], awaitingRetry: true }), /awaiting retry/);
});

test('API coverage excludes Gusto while browser jobs retain existing posting provenance', () => {
  const telemetry = readFileSync('src/lib/atsDistributedTelemetry.ts', 'utf8');
  assert.match(telemetry, /board\.platform NOT IN/);
  assert.equal((telemetry.match(/b\.platform NOT IN/g) || []).length, 4);
  const worker = readFileSync('scripts/sweep_gusto_boards.ts', 'utf8');
  assert.match(worker, /const SOURCE = 'Gusto'/);
  assert.match(worker, /const JOB_SOURCE = 'ATS-gusto'/);
  assert.match(worker, /source: JOB_SOURCE/);
  assert.match(worker, /claimDueIngestionTask\(definition\.spec\)/);
  assert.match(worker, /completeIngestionTask/);
});

test('moving Gusto retains task identity, saved work, due date and history without creating a replacement', async () => {
  const spec = GUSTO_BOARD_COLLECTION_TASK_DEFINITION.spec;
  const previousTaskKey = buildIngestionTaskKey({ ...spec, ingestionMode: 'paid-browser' });
  const row = {
    id: 'existing-gusto', taskKey: previousTaskKey, source: 'Gusto', ingestionMode: 'paid-browser',
    status: 'partial', taskKind: 'search', lifecycleStatus: 'active', leaseToken: null as string | null,
    cursor: { board: 'saved-board', offset: 4 }, seenCount: 83, watermarkAt: new Date('2026-10-16'),
    nextRunAt: new Date('2026-10-18'), lastCompletedAt: new Date('2026-10-17'),
  };
  const before = structuredClone(row);
  const writes: Array<Record<string, unknown>> = [];
  const client = { ingestionTask: {
    findMany: async () => [{ ...row }],
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      assert.equal(where.id, row.id);
      assert.equal(where.taskKey, previousTaskKey);
      assert.equal(where.leaseToken, null);
      assert.deepEqual(where.status, { not: 'running' });
      writes.push(data); Object.assign(row, data); return { count: 1 };
    },
    upsert: async () => { throw new Error('Must not create or replace the existing task'); },
  } };
  const preview = await reconcileIngestionTaskCatalog([spec], { client: client as never });
  assert.equal(writes.length, 0);
  assert.deepEqual(preview.additions, []);
  assert.deepEqual(preview.retirements, []);
  assert.equal(preview.reclassifications.length, 1);
  row.leaseToken = 'live-lease';
  await assert.rejects(reconcileIngestionTaskCatalog([spec], { apply: true, client: client as never }), /leased\/running/);
  assert.equal(writes.length, 0);
  row.leaseToken = null;
  await reconcileIngestionTaskCatalog([spec], { apply: true, client: client as never });
  assert.deepEqual(writes, [{ taskKey: buildIngestionTaskKey(spec), ingestionMode: 'public-board' }]);
  assert.deepEqual(row, { ...before, taskKey: buildIngestionTaskKey(spec), ingestionMode: 'public-board' });
  const replay = await reconcileIngestionTaskCatalog([spec], { apply: true, client: client as never });
  assert.deepEqual(replay.reclassifications, []);
  assert.equal(writes.length, 1);
});

test('board collection telemetry covers all fifteen families and refuses expired working claims', async () => {
  const now = new Date('2026-10-17T23:00:00Z');
  const client = {
    $queryRaw: async () => [{ dueBoards: 3000, sweptToday: 200 }],
    ingestionTask: { findMany: async (input: { where: { ingestionMode: string; source: { in: string[] } } }) => {
    assert.equal(input.where.ingestionMode, 'public-board');
    assert.equal(input.where.source.in.length, 15);
    assert.ok(input.where.source.in.includes('Gusto'));
    return [
      { source: 'Gusto', status: 'running', leaseToken: 'live', leaseExpiresAt: new Date(now.getTime() + 60000) },
      { source: 'ATS-paycom', status: 'running', leaseToken: 'expired', leaseExpiresAt: now },
      { source: 'ATS-adp', status: 'partial', leaseToken: null, leaseExpiresAt: null },
    ];
  } } };
  assert.deepEqual(await readAtsBoardCollectionTelemetry(now, client as never), {
    dueBoards: 3000, sweptToday: 200, runningSources: ['Gusto'], awaitingRetry: true,
  });
});

test('the previous board-lane ticker still renders as ATS Crawling during a release transition', () => {
  const rows = pipelineStatusRows('Ingestion: idle | ATS Board Collection: waiting · 12 boards due | ATS acquisition: idle | Backpressure: idle | ATS processing: idle | Local Scoring: idle | JD Extraction: idle');
  assert.deepEqual(rows.find(row => row.id === 'ats-board-collection'), {
    id: 'ats-board-collection', label: 'ATS Crawling', value: 'waiting · 12 boards due',
  });
});
