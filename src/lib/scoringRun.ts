import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  createScoringBatchInTransaction,
  lockScoringStage,
  type CreateScoringBatchInput,
} from './scoringBatch';
import { canonicalJson, canonicalJsonSha256 } from './scoringCanonicalJson';
import type { ScoringStage } from './scoringInputBinding';
import {
  MAX_SCORING_RUN_EXCHANGE_BYTES,
  MAX_SCORING_RUN_JOBS,
  SCORING_RUN_CHILD_BATCH_SIZE,
} from './scoringLimits';

export const SCORING_RUN_EXPORT_SCHEMA = 'career-dashboard-scoring-run-export-v1';
export const SCORING_RUN_RESULT_SCHEMA = 'career-dashboard-scoring-run-result-v1';

export function scoringRunExportFilename(stage: ScoringStage, runId: string): string {
  return stage === 'aim'
    ? `START-AIM-FIT-RUN-${runId}.json`
    : `START-E-FIT-RUN-${runId}.json`;
}

export function scoringRunUploadFilename(stage: ScoringStage, runId: string): string {
  return `career-dashboard-${stage}-run-upload-${runId}.json`;
}

type CreateScoringRunInput = {
  stage: ScoringStage;
  batchInputs: CreateScoringBatchInput[];
  now?: Date;
  expiryMs?: number;
};

export async function createScoringRun(prisma: PrismaClient, input: CreateScoringRunInput) {
  if (input.batchInputs.length < 1) throw new Error('scoring run must contain at least one child batch');
  if (input.batchInputs.some((batch) => batch.stage !== input.stage)) throw new Error('scoring run child stage mismatch');
  if (input.batchInputs.some((batch) => batch.items.length < 1 || batch.items.length > SCORING_RUN_CHILD_BATCH_SIZE)) {
    throw new Error(`scoring run child batches must contain 1–${SCORING_RUN_CHILD_BATCH_SIZE} jobs`);
  }
  if (input.batchInputs.slice(0, -1).some((batch) => batch.items.length !== SCORING_RUN_CHILD_BATCH_SIZE)) {
    throw new Error('only the final scoring run child may contain fewer than 40 jobs');
  }
  const jobIds = input.batchInputs.flatMap((batch) => batch.items.map((item) => item.jobId));
  if (jobIds.length > MAX_SCORING_RUN_JOBS) throw new Error(`scoring run exceeds the ${MAX_SCORING_RUN_JOBS}-job limit`);
  if (new Set(jobIds).size !== jobIds.length) throw new Error('scoring run contains duplicate jobs');

  const now = input.now || new Date();
  const expiryMs = input.expiryMs ?? 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.valueOf() + expiryMs);
  const runId = randomUUID();
  const placeholderHash = createHash('sha256').update(`building:${runId}`, 'utf8').digest('hex');

  return prisma.$transaction(async (tx) => {
    await lockScoringStage(tx, input.stage);
    const [activeRunCount, activeBatchCount] = await Promise.all([
      tx.scoringRun.count({ where: { stage: input.stage, status: 'exported' } }),
      tx.scoringBatch.count({
        where: { stage: input.stage, status: { in: ['exported', 'superseded'] }, runId: null },
      }),
    ]);
    if (activeRunCount > 0 || activeBatchCount > 0) {
      throw new Error(`${input.stage === 'aim' ? 'Aim' : 'Experience'} already has active scoring work`);
    }

    await tx.scoringRun.create({
      data: {
        id: runId,
        stage: input.stage,
        status: 'exported',
        schemaVersion: SCORING_RUN_EXPORT_SCHEMA,
        batchSize: SCORING_RUN_CHILD_BATCH_SIZE,
        jobCount: jobIds.length,
        batchCount: input.batchInputs.length,
        exportHash: placeholderHash,
        manifestHash: placeholderHash,
        exportJson: '{}',
        exportByteLength: 2,
        createdAt: now,
        expiresAt,
      },
    });

    const children = [];
    for (const [ordinal, batchInput] of input.batchInputs.entries()) {
      const child = await createScoringBatchInTransaction(tx, {
        ...batchInput,
        now,
        expiryMs,
        runId,
        runOrdinal: ordinal,
      });
      children.push(child);
    }

    const manifest = {
      kind: 'scoring_run_manifest_v1',
      runId,
      stage: input.stage,
      batchSize: SCORING_RUN_CHILD_BATCH_SIZE,
      jobCount: jobIds.length,
      batches: children.map((batch, ordinal) => ({
        ordinal,
        batchId: batch.id,
        jobCount: batch.items.length,
        exportHash: batch.exportHash,
        manifestHash: batch.manifestHash,
      })),
    };
    const manifestHash = canonicalJsonSha256(manifest);
    const exportPayload = {
      schemaVersion: SCORING_RUN_EXPORT_SCHEMA,
      run: {
        id: runId,
        stage: input.stage,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        batchSize: SCORING_RUN_CHILD_BATCH_SIZE,
        jobCount: jobIds.length,
        batchCount: children.length,
        manifestHash,
      },
      batches: children.map((batch, ordinal) => ({
        ordinal,
        batchId: batch.id,
        jobCount: batch.items.length,
        exportHash: batch.exportHash,
        export: JSON.parse(batch.exportJson) as unknown,
      })),
    };
    const exportJson = canonicalJson(exportPayload);
    const exportByteLength = Buffer.byteLength(exportJson, 'utf8');
    if (exportByteLength > MAX_SCORING_RUN_EXCHANGE_BYTES) {
      throw new Error('stored scoring run export exceeds 64 MiB');
    }
    const exportHash = createHash('sha256').update(exportJson, 'utf8').digest('hex');
    const run = await tx.scoringRun.update({
      where: { id: runId },
      data: { manifestHash, exportHash, exportJson, exportByteLength },
      include: {
        batches: {
          orderBy: { runOrdinal: 'asc' },
          include: { _count: { select: { items: true } } },
        },
      },
    });
    return { run, file: { exportJson, exportHash, filename: scoringRunExportFilename(input.stage, runId) } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}

export async function getStoredScoringRun(prisma: PrismaClient, runId: string) {
  const run = await prisma.scoringRun.findUnique({
    where: { id: runId },
    select: { stage: true, exportJson: true, exportHash: true },
  });
  if (!run) throw new Error('scoring run not found');
  if (run.stage !== 'aim' && run.stage !== 'experience') throw new Error('stored scoring run stage is invalid');
  if (createHash('sha256').update(run.exportJson, 'utf8').digest('hex') !== run.exportHash) {
    throw new Error('stored scoring run export hash mismatch');
  }
  return {
    exportJson: run.exportJson,
    exportHash: run.exportHash,
    filename: scoringRunExportFilename(run.stage, runId),
  };
}

export async function extendScoringRun(prisma: PrismaClient, runId: string, expiresAt: Date) {
  if (expiresAt.valueOf() <= Date.now()) throw new Error('extended expiry must be in the future');
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT id, status FROM "ScoringRun" WHERE id = ${runId} FOR UPDATE
    `);
    if (!locked || locked.status !== 'exported') throw new Error('only an active scoring run can be extended');
    const blocked = await tx.scoringBatch.count({
      where: { runId, status: { notIn: ['exported', 'completed'] } },
    });
    if (blocked > 0) throw new Error('a scoring run with an unavailable child must be released');
    await tx.scoringBatch.updateMany({
      where: { runId, status: 'exported' },
      data: { expiresAt },
    });
    return tx.scoringRun.update({ where: { id: runId }, data: { expiresAt } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function releaseScoringRun(prisma: PrismaClient, runId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT id, status FROM "ScoringRun" WHERE id = ${runId} FOR UPDATE
    `);
    if (!locked || locked.status !== 'exported') throw new Error('only an active scoring run can be released');
    const batches = await tx.scoringBatch.findMany({ where: { runId }, select: { id: true, status: true } });
    const pendingBatchIds = batches.filter((batch) => batch.status !== 'completed').map((batch) => batch.id);
    if (pendingBatchIds.length > 0) {
      await tx.scoringBatchItem.updateMany({
        where: { batchId: { in: pendingBatchIds }, status: 'leased' },
        data: { status: 'released', releasedAt: now },
      });
      await tx.scoringBatch.updateMany({
        where: { id: { in: pendingBatchIds }, status: { in: ['exported', 'superseded'] } },
        data: { status: 'released', releasedAt: now },
      });
    }
    const incomplete = await tx.scoringBatch.count({ where: { runId, status: { not: 'completed' } } });
    if (incomplete === 0) {
      throw new Error('scoring run finished while release was waiting; re-upload the exact result to finalize it');
    }
    return tx.scoringRun.update({
      where: { id: runId },
      data: { status: 'released', releasedAt: now },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });
}
