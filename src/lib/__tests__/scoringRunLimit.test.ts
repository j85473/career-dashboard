import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Prisma, PrismaClient } from '@prisma/client';

import { aimSourceJdHash, aimTrustedMetadataHash } from '../aimIdentity';
import type { CreateScoringBatchInput } from '../scoringBatch';
import { exportScoringRun } from '../scoringExport';
import type { ScoringStage } from '../scoringInputBinding';
import { createScoringRun, getStoredScoringRun } from '../scoringRun';

// Exercise the real selectors, manifests, and export validation against an
// in-memory database double; no database writes or model calls are needed.
function exportDatabase(stage: ScoringStage, queueSize: number) {
  const updatedAt = new Date('2026-09-03T12:00:00Z');
  const jobs = Array.from({ length: queueSize }, () => ({
    id: randomUUID(),
    title: 'Partner Account Manager',
    company: 'Example Company',
    location: 'Minneapolis, MN',
    canonicalUrl: 'https://example.com/jobs/partner-account-manager',
    url: 'https://example.com/jobs/partner-account-manager',
    description: 'Manage existing channel partner relationships and support their account growth.',
    updatedAt,
    aimFailureReceipts: [],
  }));
  const extractions = jobs.map((job) => ({
    id: randomUUID(),
    scope: 'stage1',
    sourceJdHash: aimSourceJdHash(job.description),
    trustedMetadataHash: aimTrustedMetadataHash(job),
    staleAt: null,
  }));
  const events = jobs.map((job, index) => ({
    id: randomUUID(),
    jobId: job.id,
    family: 'aim',
    evaluationType: 'aim_fit',
    schemaVersion: 'career-dashboard-aim-result-v2',
    passed: true,
    staleAt: null,
    aimFactualExtractionId: extractions[index].id,
    semanticResultHash: 'a'.repeat(64),
    inputBindings: { source: { sourceJdHash: extractions[index].sourceJdHash } },
    extractionId: extractions[index].id,
    extractionSourceJdHash: extractions[index].sourceJdHash,
    extractionStaleAt: null,
  }));
  const leased = new Set<string>();
  let transactionCount = 0;
  let storedRun: Record<string, unknown> = {};
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (query: Prisma.Sql) => jobs.filter((job) => query.values.includes(job.id)),
    scoringRun: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => { storedRun = data; return data; },
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(storedRun, data),
    },
    scoringBatch: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> & { items: { create: Array<{ jobId: string }> } } }) => {
        for (const item of data.items.create) leased.add(item.jobId);
        return { ...data, items: data.items.create };
      },
    },
  };
  const prisma = {
    job: {
      findMany: async ({ skip, take }: { skip: number; take: number }) => (
        jobs.filter((job) => !leased.has(job.id)).slice(skip, skip + take)
      ),
    },
    $queryRaw: async () => stage === 'experience' ? events : [],
    aimFactualExtraction: {
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id: string } }) => extractions.find((row) => row.id === where.id),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      transactionCount++;
      return callback(tx);
    },
  } as unknown as PrismaClient;
  return { prisma, jobs, leased, transactionCount: () => transactionCount };
}

for (const stage of ['aim', 'experience'] as const) {
  for (const queueSize of [17, 200, 201, 450]) {
    test(`${stage}: ${queueSize} ready jobs export at most 200 and leave the rest unleased`, async () => {
      const database = exportDatabase(stage, queueSize);
      const { file } = await exportScoringRun(database.prisma, stage);
      const exported = JSON.parse(file.exportJson);
      const expectedCount = Math.min(queueSize, 200);
      const exportedIds = exported.batches.flatMap((child: { export: { jobs: Array<{ jobId: string }> } }) => (
        child.export.jobs.map((job) => job.jobId)
      ));

      assert.equal(exported.run.stage, stage);
      assert.equal(exported.run.jobCount, expectedCount);
      assert.equal(exported.run.batchCount, Math.ceil(expectedCount / 40));
      assert.deepEqual(exportedIds, database.jobs.slice(0, expectedCount).map((job) => job.id));
      assert.deepEqual([...database.leased], exportedIds);
      assert.equal(database.jobs.filter((job) => !database.leased.has(job.id)).length, queueSize - expectedCount);
      for (const child of exported.batches) {
        assert.ok(child.jobCount <= 40);
        assert.deepEqual(child.export.jobs.map((job: { ordinal: number }) => job.ordinal),
          Array.from({ length: child.jobCount }, (_, index) => index));
      }
    });
  }

  test(`${stage}: an empty queue creates no run or leases`, async () => {
    const database = exportDatabase(stage, 0);
    await assert.rejects(exportScoringRun(database.prisma, stage), /no .* Ready jobs are available/);
    assert.equal(database.transactionCount(), 0);
    assert.equal(database.leased.size, 0);
  });

  test(`${stage}: direct run creation rejects 201 jobs before opening a transaction`, async () => {
    const database = exportDatabase(stage, 201);
    const batchInputs = Array.from({ length: 6 }, (_, index) => ({
      stage,
      items: database.jobs.slice(index * 40, (index + 1) * 40).map((job) => ({ jobId: job.id })),
    })) as CreateScoringBatchInput[];
    await assert.rejects(createScoringRun(database.prisma, { stage, batchInputs }), /exceeds the 200-job limit/);
    assert.equal(database.transactionCount(), 0);
    assert.equal(database.leased.size, 0);
  });

  test(`${stage}: previously stored runs larger than 200 still re-download unchanged`, async () => {
    const runId = randomUUID();
    const exportJson = JSON.stringify({ run: { id: runId, stage, jobCount: 240 } });
    const exportHash = createHash('sha256').update(exportJson).digest('hex');
    const prisma = {
      scoringRun: { findUnique: async () => ({ stage, exportJson, exportHash }) },
    } as unknown as PrismaClient;
    const file = await getStoredScoringRun(prisma, runId);
    assert.equal(file.exportJson, exportJson);
    assert.equal(file.exportHash, exportHash);
  });
}
