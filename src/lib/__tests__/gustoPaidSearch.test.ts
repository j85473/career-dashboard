import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { claimNextAtsV2Continuation } from '../atsAcquisitionLedger';
import { planAtsTaskModeTransition, type AtsTaskModeRow } from '../atsTaskMode';
import { buildIngestionTaskKey } from '../ingestionControl';
import { canonicalIngestionTaskDefinitions, GUSTO_PAID_SEARCH_TASK_DEFINITION } from '../ingestionTaskCatalog';
import { emptyGustoApiBatchWhere, formatGustoPaidSearchTelemetry, reconcileGustoApiBatches } from '../gustoPaidSearch';
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

test('routing keeps audit history and cannot claim a successful API sweep', async (t) => {
  const writes: Array<{ target: string; input: Record<string, unknown> }> = [];
  const reads: Array<{ where: Prisma.AtsIngestionBatchWhereInput }> = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ id: 'empty-gusto' }],
    atsIngestionBatch: {
      findMany: async (input: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        reads.push(input);
        return [{ id: 'empty-gusto' }];
      },
      updateMany: async (input: Record<string, unknown>) => { writes.push({ target: 'batch', input }); return { count: 1 }; },
    },
    atsEndpointSweepReceipt: {
      updateMany: async (input: Record<string, unknown>) => { writes.push({ target: 'sweep', input }); return { count: 1 }; },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await reconcileGustoApiBatches(), 1);
  assert.equal(reads.length, 3);
  assert.equal(reads[0].where.pages, undefined, 'the initial scan must not join historical pages');
  assert.deepEqual(reads[1].where.id, { in: ['empty-gusto'] });
  assert.deepEqual(reads[1].where.pages, { none: {} }, 'the bounded second pass must still prove no acquired pages');
  assert.equal(writes.length, 2);
  const batch = writes[0].input.data as Record<string, unknown>;
  assert.equal(batch.status, 'routed');
  assert.equal(Object.hasOwn(batch, 'processedAt'), false);
  const sweep = writes[1].input.data as Record<string, unknown>;
  assert.equal(sweep.state, 'failed');
  assert.equal(sweep.outcome, 'routed_to_paid_search');
  assert.equal(Object.hasOwn(sweep, 'processedAt'), false);
  assert.deepEqual((writes[0].input.where as Prisma.AtsIngestionBatchWhereInput).observations, { none: {} });
});

test('a protected batch at the front cannot block later empty Gusto batches', async (t) => {
  const reads: Array<{ where: Prisma.AtsIngestionBatchWhereInput }> = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ id: 'empty-gusto' }],
    atsIngestionBatch: {
      findMany: async (input: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        reads.push(input);
        if (reads.length === 1) return [{ id: 'protected' }];
        if (reads.length === 2) return [];
        return [{ id: 'empty-gusto' }];
      },
      updateMany: async () => ({ count: 1 }),
    },
    atsEndpointSweepReceipt: { updateMany: async () => ({ count: 1 }) },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<number>) => run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await reconcileGustoApiBatches(), 1);
  assert.deepEqual(reads[2].where.id, { gt: 'protected' });
  assert.deepEqual(reads[3].where.id, { in: ['empty-gusto'] });
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
