import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import type { Prisma, PrismaClient } from '@prisma/client';

import { getStoredScoringExport, releaseScoringBatch, supersedeScoringBatch } from '../scoringBatch';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';

test('stored export re-download is byte-identical and detects persistence corruption', async () => {
  const exportJson = '{"jobs":[{"ordinal":0}],"schemaVersion":"test"}';
  const exportHash = createHash('sha256').update(exportJson, 'utf8').digest('hex');
  const batch = { stage: 'aim', exportJson, exportHash };
  const prisma = { scoringBatch: { findUnique: async () => batch } } as unknown as PrismaClient;

  const first = await getStoredScoringExport(prisma, BATCH_ID);
  const second = await getStoredScoringExport(prisma, BATCH_ID);
  assert.deepEqual(second, first);
  assert.equal(Buffer.compare(Buffer.from(first.exportJson), Buffer.from(second.exportJson)), 0);
  assert.equal(first.filename, `career-dashboard-aim-export-${BATCH_ID}.json`);

  batch.exportJson += ' ';
  await assert.rejects(getStoredScoringExport(prisma, BATCH_ID), /stored scoring export hash mismatch/);
});

test('supersession retains all leases and explicit release changes the whole batch atomically', async () => {
  const now = new Date('2026-08-12T18:00:00.000Z');
  const batch = {
    id: BATCH_ID,
    status: 'exported',
    items: [{ id: 'item-1', status: 'leased' }, { id: 'item-2', status: 'leased' }],
  };
  const tx = {
    scoringBatch: {
      findUnique: async () => batch,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(batch, data),
    },
  } as unknown as Prisma.TransactionClient;

  await supersedeScoringBatch(tx, BATCH_ID, 'input version changed', now);
  assert.equal(batch.status, 'superseded');
  assert.deepEqual(batch.items.map((item) => item.status), ['leased', 'leased']);

  let committed = false;
  const prisma = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      const working = structuredClone(batch);
      const releaseTx = {
        $queryRaw: async () => [{ id: BATCH_ID, status: working.status }],
        scoringBatchItem: {
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            working.items.forEach((item) => Object.assign(item, data));
          },
        },
        scoringBatch: {
          update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(working, data),
        },
      };
      const result = await callback(releaseTx);
      Object.assign(batch, working);
      committed = true;
      return result;
    },
  } as unknown as PrismaClient;
  await releaseScoringBatch(prisma, BATCH_ID, now);
  assert.equal(committed, true);
  assert.equal(batch.status, 'released');
  assert.deepEqual(batch.items.map((item) => item.status), ['released', 'released']);
});

test('database migration enforces concurrent batch and lease cardinality', () => {
  const migration = fs.readFileSync('prisma/migrations/20260812170000_manual_scoring_exchange_v1/migration.sql', 'utf8');
  assert.match(migration, /CREATE UNIQUE INDEX "ScoringBatch_one_nonterminal_per_stage"[\s\S]*WHERE "status" IN \('exported', 'superseded'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "ScoringBatchItem_one_active_lease_per_job"[\s\S]*WHERE "status" = 'leased'/);
  assert.match(migration, /ScoringBatchItem_batchId_ordinal_key/);
  assert.match(migration, /ScoringBatchItem_batchId_jobId_key/);
});
