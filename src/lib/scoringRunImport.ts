import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { createScoringApprovalToken, verifyScoringApprovalToken } from './scoringApproval';
import { canonicalJson, canonicalJsonSha256 } from './scoringCanonicalJson';
import { applyScoringImport, previewScoringImport, type ScoringImportPreview } from './scoringImport';
import { MAX_SCORING_RUN_EXCHANGE_BYTES } from './scoringLimits';
import { SCORING_RUN_RESULT_SCHEMA } from './scoringRun';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function parseRunJson(raw: string | Buffer): JsonRecord {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (bytes.byteLength > MAX_SCORING_RUN_EXCHANGE_BYTES) throw new Error('scoring run exchange exceeds 64 MiB');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('scoring run exchange is not valid UTF-8 JSON');
  }
  return record(value, 'scoring run exchange');
}

type RunBatchResult = {
  ordinal: number;
  batchId: string;
  exportHash: string;
  resultHash: string;
  result: JsonRecord;
};

function validateResultEnvelope(payload: JsonRecord): { run: JsonRecord; batches: RunBatchResult[]; resultHash: string } {
  if (payload.schemaVersion !== SCORING_RUN_RESULT_SCHEMA) throw new Error('unsupported scoring run result schema');
  const resultHash = string(payload.resultHash, 'run resultHash');
  const withoutHash = { ...payload };
  delete withoutHash.resultHash;
  if (canonicalJsonSha256(withoutHash) !== resultHash) throw new Error('scoring run resultHash mismatch');
  const run = record(payload.run, 'result run');
  const batches = array(payload.batches, 'result batches').map((value, index): RunBatchResult => {
    const entry = record(value, `result batch ${index}`);
    const result = record(entry.result, `result batch ${index} payload`);
    const parsed = {
      ordinal: integer(entry.ordinal, `result batch ${index} ordinal`),
      batchId: string(entry.batchId, `result batch ${index} ID`),
      exportHash: string(entry.exportHash, `result batch ${index} exportHash`),
      resultHash: string(entry.resultHash, `result batch ${index} resultHash`),
      result,
    };
    if (parsed.ordinal !== index) throw new Error('scoring run result batch order mismatch');
    if (result.resultHash !== parsed.resultHash) throw new Error(`scoring run child ${index} result hash mismatch`);
    return parsed;
  });
  return { run, batches, resultHash };
}

function experienceMismatchReceipts(batches: RunBatchResult[]): Array<{
  batchId: string;
  jobId: string;
  resultHash: string;
}> {
  const receipts: Array<{ batchId: string; jobId: string; resultHash: string }> = [];
  for (const batch of batches) {
    for (const value of array(batch.result.results, 'Experience child results')) {
      const item = record(value, 'Experience child result');
      const result = record(item.result, 'Experience child decision');
      if (result.kind === 'evaluation' && result.decision === 'hard_requirement_mismatch') {
        receipts.push({
          batchId: batch.batchId,
          jobId: string(item.jobId, 'Experience mismatch jobId'),
          resultHash: string(item.resultHash, 'Experience mismatch resultHash'),
        });
      }
    }
  }
  return receipts;
}

function validateSemanticReview(payload: JsonRecord, stage: string, runId: string, batches: RunBatchResult[]): void {
  if (stage !== 'experience') {
    if (payload.semanticReview !== undefined && payload.semanticReview !== null) {
      throw new Error('Aim scoring run must not contain an Experience semantic review');
    }
    return;
  }
  const review = record(payload.semanticReview, 'Experience semantic review');
  if (review.status !== 'approved' || review.reviewer !== 'codex-main-agent') {
    throw new Error('Experience scoring run requires an approved main-agent semantic review');
  }
  string(review.reviewedAt, 'Experience semantic review reviewedAt');
  const expected = experienceMismatchReceipts(batches);
  const reviewed = array(review.reviews, 'Experience semantic reviews').map((value, index) => {
    const item = record(value, `Experience semantic review ${index}`);
    if (item.decision !== 'approved') throw new Error('every Experience hard mismatch must be explicitly approved');
    return {
      batchId: string(item.batchId, 'Experience review batchId'),
      jobId: string(item.jobId, 'Experience review jobId'),
      resultHash: string(item.resultHash, 'Experience review resultHash'),
    };
  });
  if (canonicalJson(reviewed) !== canonicalJson(expected)) {
    throw new Error('Experience semantic review does not cover every exact hard mismatch');
  }
  const expectedHash = canonicalJsonSha256({ kind: 'experience_run_semantic_review_v1', runId, reviews: reviewed });
  if (review.reviewHash !== expectedHash) throw new Error('Experience semantic review hash mismatch');
}

type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function loadRun(prisma: PrismaClient, payload: JsonRecord) {
  const validated = validateResultEnvelope(payload);
  const runId = string(validated.run.id, 'run ID');
  const run = await prisma.scoringRun.findUnique({
    where: { id: runId },
    include: {
      batches: {
        orderBy: { runOrdinal: 'asc' },
        include: { items: { orderBy: { ordinal: 'asc' } } },
      },
    },
  });
  if (!run) throw new Error('scoring run not found');
  if (run.stage !== 'aim' && run.stage !== 'experience') throw new Error('stored scoring run stage is invalid');
  if (createHash('sha256').update(run.exportJson, 'utf8').digest('hex') !== run.exportHash) {
    throw new Error('stored scoring run export hash mismatch');
  }
  const bindings: Array<[unknown, unknown, string]> = [
    [validated.run.id, run.id, 'ID'],
    [validated.run.stage, run.stage, 'stage'],
    [validated.run.exportHash, run.exportHash, 'exportHash'],
    [validated.run.manifestHash, run.manifestHash, 'manifestHash'],
    [validated.run.jobCount, run.jobCount, 'jobCount'],
    [validated.run.batchCount, run.batchCount, 'batchCount'],
    [validated.batches.length, run.batches.length, 'child count'],
  ];
  for (const [actual, expected, field] of bindings) {
    if (actual !== expected) throw new Error(`scoring run result ${field} mismatch`);
  }
  for (const [index, child] of run.batches.entries()) {
    const supplied = validated.batches[index];
    if (!supplied || supplied.ordinal !== child.runOrdinal || supplied.batchId !== child.id
      || supplied.exportHash !== child.exportHash) {
      throw new Error(`scoring run child ${index} binding mismatch`);
    }
  }
  validateSemanticReview(payload, run.stage, run.id, validated.batches);
  return { ...validated, stored: run };
}

export type ScoringRunImportPreview = ScoringImportPreview & {
  kind: 'run';
  runId: string;
  batchCount: number;
  completedBatchCount: number;
};

async function buildRunPreview(
  prisma: PrismaClient,
  loaded: LoadedRun,
  options: { approvalSecret?: string; now?: Date },
) {
  const now = options.now || new Date();
  if (loaded.stored.status === 'released') throw new Error('released scoring run is not importable');
  if (loaded.stored.status === 'exported' && loaded.stored.expiresAt.valueOf() <= now.valueOf()) {
    throw new Error('expired scoring run requires explicit extension or release');
  }
  const childPreviews = [];
  for (const child of loaded.batches) {
    childPreviews.push(await previewScoringImport(
      prisma,
      canonicalJson(child.result),
      { approvalSecret: options.approvalSecret, now, allowRunChild: true },
    ));
  }
  const previews = childPreviews.map((child) => child.preview);
  const scores = previews.flatMap((preview) => preview.scoreRange
    ? [preview.scoreRange.minimum, preview.scoreRange.maximum]
    : []);
  const decisionCounts: Record<string, number> = {};
  for (const preview of previews) {
    for (const [decision, count] of Object.entries(preview.decisionCounts)) {
      decisionCounts[decision] = (decisionCounts[decision] || 0) + count;
    }
  }
  let globalOrdinal = 0;
  const projections = previews.flatMap((preview, batchOrdinal) => preview.projections.map((projection) => ({
    ...projection,
    ordinal: globalOrdinal++,
    batchOrdinal,
    childOrdinal: projection.ordinal,
  })));
  const preview: ScoringRunImportPreview = {
    version: 2,
    kind: 'run',
    runId: loaded.stored.id,
    batchId: loaded.stored.id,
    stage: loaded.stored.stage as 'aim' | 'experience',
    resultHash: loaded.resultHash,
    applicable: true,
    itemCount: previews.reduce((sum, child) => sum + child.itemCount, 0),
    expectedCount: loaded.stored.jobCount,
    suppliedCount: previews.reduce((sum, child) => sum + child.suppliedCount, 0),
    acceptedCount: previews.reduce((sum, child) => sum + child.acceptedCount, 0),
    rejectedCount: previews.reduce((sum, child) => sum + child.rejectedCount, 0),
    safeFailureCount: previews.reduce((sum, child) => sum + child.safeFailureCount, 0),
    cannotEvaluateCount: previews.reduce((sum, child) => sum + child.cannotEvaluateCount, 0),
    doesNotMeetCount: previews.reduce((sum, child) => sum + child.doesNotMeetCount, 0),
    protectedLifecycleCount: previews.reduce((sum, child) => sum + child.protectedLifecycleCount, 0),
    scoreRange: scores.length ? { minimum: Math.min(...scores), maximum: Math.max(...scores) } : null,
    decisionCounts,
    projections,
    batchCount: loaded.stored.batchCount,
    completedBatchCount: loaded.stored.batches.filter((batch) => batch.status === 'completed').length,
  };
  return { preview, childPreviews };
}

export async function previewScoringRunImport(
  prisma: PrismaClient,
  rawPayload: string | Buffer,
  options: { approvalSecret?: string; now?: Date } = {},
) {
  const payload = parseRunJson(rawPayload);
  const loaded = await loadRun(prisma, payload);
  if (loaded.stored.status === 'completed') {
    if (loaded.stored.acceptedResultHash !== loaded.resultHash) throw new Error('completed run rejects divergent replay');
    const { preview } = await buildRunPreview(prisma, loaded, options);
    return { preview, approvalToken: null, approvalExpiresAt: null };
  }
  const { preview } = await buildRunPreview(prisma, loaded, options);
  const approval = createScoringApprovalToken(
    { batchId: loaded.stored.id, resultHash: loaded.resultHash, preview },
    { secret: options.approvalSecret, now: options.now },
  );
  return { preview, approvalToken: approval.token, approvalExpiresAt: approval.claims.expiresAt };
}

export async function applyScoringRunImport(
  prisma: PrismaClient,
  rawPayload: string | Buffer,
  approvalToken: string,
  options: { approvalSecret?: string; now?: Date } = {},
) {
  const payload = parseRunJson(rawPayload);
  const loaded = await loadRun(prisma, payload);
  if (loaded.stored.status === 'completed') {
    if (loaded.stored.acceptedResultHash !== loaded.resultHash) throw new Error('completed run rejects divergent replay');
    const imported = loaded.stored.batches.flatMap((batch) => batch.items).filter((item) => item.status === 'imported').length;
    return {
      runId: loaded.stored.id,
      resultHash: loaded.resultHash,
      idempotentReplay: true,
      imported,
      released: loaded.stored.jobCount - imported,
      completedBatches: loaded.stored.batchCount,
    };
  }
  const now = options.now || new Date();
  const { preview, childPreviews } = await buildRunPreview(prisma, loaded, { ...options, now });
  verifyScoringApprovalToken(
    approvalToken,
    { batchId: loaded.stored.id, resultHash: loaded.resultHash, preview },
    { now, secret: options.approvalSecret },
  );

  let imported = 0;
  let released = 0;
  for (const [index, child] of loaded.batches.entries()) {
    const childPreview = childPreviews[index];
    if (!childPreview.approvalToken) {
      imported += childPreview.preview.acceptedCount;
      released += childPreview.preview.safeFailureCount;
      continue;
    }
    const receipt = await applyScoringImport(
      prisma,
      canonicalJson(child.result),
      childPreview.approvalToken,
      { approvalSecret: options.approvalSecret, now, allowRunChild: true },
    );
    imported += receipt.imported;
    released += receipt.released;
  }

  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT id, status FROM "ScoringRun" WHERE id = ${loaded.stored.id} FOR UPDATE
    `);
    if (!locked) throw new Error('scoring run not found');
    const incomplete = await tx.scoringBatch.count({
      where: { runId: loaded.stored.id, status: { not: 'completed' } },
    });
    if (incomplete !== 0) throw new Error('scoring run still has incomplete child batches');
    if (locked.status !== 'exported') throw new Error('scoring run was released before completion');
    await tx.scoringRun.update({
      where: { id: loaded.stored.id },
      data: {
        status: 'completed',
        completedAt: now,
        acceptedResultHash: loaded.resultHash,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return {
    runId: loaded.stored.id,
    resultHash: loaded.resultHash,
    idempotentReplay: false,
    imported,
    released,
    completedBatches: loaded.stored.batchCount,
  };
}
