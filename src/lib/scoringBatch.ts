import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { canonicalJson, canonicalJsonSha256 } from './scoringCanonicalJson';
import {
  MAX_SCORING_EXCHANGE_BYTES,
  SCORING_PROTOCOL_V1,
  SCORING_PROTOCOL_V2,
  parseScoringExchangeJson,
  validateExportManifest,
} from './scoringExchange';
import { aimV2ManifestHash, scoringManifestHash, type ScoringStage } from './scoringInputBinding';
import { MANUAL_SCORING_BATCH_SIZE } from './scoringLimits';

type DbClient = PrismaClient | Prisma.TransactionClient;

export function scoringExportFilename(stage: ScoringStage, batchId: string): string {
  return stage === 'aim'
    ? `START-AIM-FIT-${batchId}.json`
    : `START-E-FIT-${batchId}.json`;
}

export type ScoringBatchSourceItem = {
  jobId: string;
  submittedUpdatedAt: Date;
  sourceJdHash: string;
  inputHash: string;
  inputSnapshot: Prisma.InputJsonValue;
  sourceAimEventId?: string;
  cleanedArtifactId?: string;
  aimFactualExtractionId?: string;
  latestPacketPlanHash?: string;
  manualRetryOfFailureReceiptId?: string;
  manualRetryReason?: string;
};

export type ScoringBatchAuthorityBindings = {
  questionRegistryHash?: string;
  promptContractHash?: string;
  responseContractHash?: string;
  runnerProtocolHash?: string;
  packetStrategyHash?: string;
  scoringPolicyHash?: string;
  anonymizationPolicyHash?: string;
  resultBuilderSemanticVersion?: string;
};

export type CreateScoringBatchInput = ScoringBatchAuthorityBindings & {
  stage: ScoringStage;
  schemaVersion:
    | 'career-dashboard-aim-export-v1'
    | 'career-dashboard-experience-export-v1'
    | 'career-dashboard-aim-export-v2'
    | 'career-dashboard-experience-export-v2';
  policyVersion: string;
  protocolVersion?: typeof SCORING_PROTOCOL_V1 | typeof SCORING_PROTOCOL_V2;
  inputVersionsHash: string;
  preferenceHash?: string;
  employerOverridesHash?: string;
  resumeHash?: string;
  evidenceHash?: string;
  items: ScoringBatchSourceItem[];
  buildExport: (context: {
    batchId: string;
    createdAt: string;
    expiresAt: string;
    manifestHash: string;
    protocolVersion: string;
  }) => Record<string, unknown>;
  now?: Date;
  expiryMs?: number;
};

function exactTimestamp(value: Date): string {
  return value.toISOString();
}

function protocolForInput(input: CreateScoringBatchInput): string {
  const inferred = input.schemaVersion.endsWith('-v2') ? SCORING_PROTOCOL_V2 : SCORING_PROTOCOL_V1;
  if (input.protocolVersion && input.protocolVersion !== inferred) throw new Error('scoring batch protocol/schema mismatch');
  return inferred;
}

function validateCreateInput(input: CreateScoringBatchInput): void {
  const maximum = MANUAL_SCORING_BATCH_SIZE;
  if (input.items.length < 1 || input.items.length > maximum) throw new Error(`scoring batch must contain 1–${maximum} items`);
  if (new Set(input.items.map((item) => item.jobId)).size !== input.items.length) throw new Error('scoring batch contains duplicate jobs');
  for (const item of input.items) {
    const snapshot = item.inputSnapshot as unknown;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).globalInputVersionsHash !== input.inputVersionsHash) {
      throw new Error(`job ${item.jobId} input snapshot does not bind current global inputs`);
    }
    if (item.manualRetryOfFailureReceiptId) {
      const reason = item.manualRetryReason?.normalize('NFC').trim();
      if (!reason || [...reason].length > 500) throw new Error('manual Aim retry requires a bounded operator reason');
    } else if (item.manualRetryReason) {
      throw new Error('manual retry reason requires a failure-receipt binding');
    }
  }
  if (input.stage === 'aim' && (input.resumeHash || input.evidenceHash)) throw new Error('Aim batch must not bind resume or evidence');
  if (input.stage === 'experience' && (!input.resumeHash || !input.evidenceHash)) throw new Error('Experience batch must bind resume and evidence');
  if (input.schemaVersion === 'career-dashboard-aim-export-v2') {
    for (const [key, value] of Object.entries({
      questionRegistryHash: input.questionRegistryHash,
      promptContractHash: input.promptContractHash,
      responseContractHash: input.responseContractHash,
      runnerProtocolHash: input.runnerProtocolHash,
      packetStrategyHash: input.packetStrategyHash,
      scoringPolicyHash: input.scoringPolicyHash,
      anonymizationPolicyHash: input.anonymizationPolicyHash,
      resultBuilderSemanticVersion: input.resultBuilderSemanticVersion,
    })) {
      if (typeof value !== 'string' || !value) throw new Error(`Aim v2 batch ${key} is required`);
    }
  }
}

function manifestForInput(
  input: CreateScoringBatchInput,
  batchId: string,
  protocolVersion: string,
): string {
  const items = input.items.map((item, ordinal) => ({ ordinal, jobId: item.jobId, inputHash: item.inputHash }));
  if (input.schemaVersion === 'career-dashboard-aim-export-v2') {
    return aimV2ManifestHash({
      batchId,
      protocolVersion,
      exportSchemaVersion: input.schemaVersion,
      scoringPolicyVersion: input.policyVersion,
      questionRegistryHash: input.questionRegistryHash!,
      promptContractHash: input.promptContractHash!,
      responseContractHash: input.responseContractHash!,
      packetStrategyHash: input.packetStrategyHash!,
      items,
    });
  }
  return scoringManifestHash({
    batchId,
    stage: input.stage,
    schemaVersion: input.schemaVersion,
    protocolVersion,
    policyVersion: input.policyVersion,
    items,
  });
}

export async function createScoringBatchInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateScoringBatchInput,
) {
  validateCreateInput(input);
  const protocolVersion = protocolForInput(input);
  const now = input.now || new Date();
  const expiresAt = new Date(now.valueOf() + (input.expiryMs ?? 24 * 60 * 60 * 1000));
  const batchId = randomUUID();
  const manifestHash = manifestForInput(input, batchId, protocolVersion);
  const exportPayload = input.buildExport({
    batchId,
    createdAt: exactTimestamp(now),
    expiresAt: exactTimestamp(expiresAt),
    manifestHash,
    protocolVersion,
  });
  const parsed = parseScoringExchangeJson(canonicalJson(exportPayload));
  validateExportManifest(parsed);
  const exportJson = canonicalJson(parsed);
  const exportByteLength = Buffer.byteLength(exportJson, 'utf8');
  if (exportByteLength > MAX_SCORING_EXCHANGE_BYTES) throw new Error('stored scoring export exceeds 32 MiB');
  const exportHash = createHash('sha256').update(exportJson, 'utf8').digest('hex');

  const locked = await tx.$queryRaw<Array<{ id: string; updatedAt: Date }>>(Prisma.sql`
    SELECT id, "updatedAt" FROM "Job" WHERE id IN (${Prisma.join(input.items.map((item) => item.jobId))}) FOR UPDATE
  `);
  if (locked.length !== input.items.length) throw new Error('one or more scoring jobs no longer exist');
  const byId = new Map(locked.map((job) => [job.id, job.updatedAt.valueOf()]));
  for (const item of input.items) {
    if (byId.get(item.jobId) !== item.submittedUpdatedAt.valueOf()) throw new Error(`job ${item.jobId} changed before export`);
  }

  return tx.scoringBatch.create({
    data: {
      id: batchId,
      stage: input.stage,
      status: 'exported',
      schemaVersion: input.schemaVersion,
      protocolVersion,
      policyVersion: input.policyVersion,
      exportHash,
      manifestHash,
      preferenceHash: input.preferenceHash,
      employerOverridesHash: input.employerOverridesHash,
      resumeHash: input.resumeHash,
      evidenceHash: input.evidenceHash,
      inputVersionsHash: input.inputVersionsHash,
      questionRegistryHash: input.questionRegistryHash,
      promptContractHash: input.promptContractHash,
      responseContractHash: input.responseContractHash,
      runnerProtocolHash: input.runnerProtocolHash,
      packetStrategyHash: input.packetStrategyHash,
      scoringPolicyHash: input.scoringPolicyHash,
      anonymizationPolicyHash: input.anonymizationPolicyHash,
      resultBuilderSemanticVersion: input.resultBuilderSemanticVersion,
      manifestSnapshot: input.items.map((item, ordinal) => ({ ordinal, jobId: item.jobId, inputHash: item.inputHash })),
      exportJson,
      exportByteLength,
      createdAt: now,
      expiresAt,
      items: {
        create: input.items.map((item, ordinal) => ({
          jobId: item.jobId,
          stage: input.stage,
          ordinal,
          status: 'leased',
          submittedUpdatedAt: item.submittedUpdatedAt,
          sourceJdHash: item.sourceJdHash,
          inputHash: item.inputHash,
          inputSnapshot: item.inputSnapshot,
          sourceAimEventId: item.sourceAimEventId,
          cleanedArtifactId: item.cleanedArtifactId,
          aimFactualExtractionId: item.aimFactualExtractionId,
          latestPacketPlanHash: item.latestPacketPlanHash,
          manualRetryOfFailureReceiptId: item.manualRetryOfFailureReceiptId,
          manualRetryReason: item.manualRetryReason?.normalize('NFC').trim(),
        })),
      },
    },
    include: { items: { orderBy: { ordinal: 'asc' } } },
  });
}

export async function createScoringBatch(prisma: PrismaClient, input: CreateScoringBatchInput) {
  return prisma.$transaction(
    (tx) => createScoringBatchInTransaction(tx, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function getStoredScoringExport(
  prisma: DbClient,
  batchId: string,
): Promise<{ exportJson: string; exportHash: string; filename: string }> {
  const batch = await prisma.scoringBatch.findUnique({
    where: { id: batchId },
    select: { stage: true, exportJson: true, exportHash: true },
  });
  if (!batch) throw new Error('scoring batch not found');
  if (createHash('sha256').update(batch.exportJson, 'utf8').digest('hex') !== batch.exportHash) {
    throw new Error('stored scoring export hash mismatch');
  }
  if (batch.stage !== 'aim' && batch.stage !== 'experience') {
    throw new Error('stored scoring batch stage is invalid');
  }
  return {
    exportJson: batch.exportJson,
    exportHash: batch.exportHash,
    filename: scoringExportFilename(batch.stage, batchId),
  };
}

export async function extendScoringBatch(prisma: PrismaClient, batchId: string, expiresAt: Date) {
  if (expiresAt.valueOf() <= Date.now()) throw new Error('extended expiry must be in the future');
  return prisma.scoringBatch.update({ where: { id: batchId, status: 'exported' }, data: { expiresAt } });
}

export async function supersedeScoringBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
  reason: string,
  now = new Date(),
) {
  const batch = await tx.scoringBatch.findUnique({ where: { id: batchId }, include: { items: true } });
  if (!batch || batch.status !== 'exported') throw new Error('only an exported batch can be superseded');
  if (batch.items.some((item) => item.status !== 'leased')) throw new Error('supersession requires every item to remain leased');
  return tx.scoringBatch.update({
    where: { id: batchId },
    data: { status: 'superseded', supersededAt: now, supersededReason: reason },
  });
}

export async function releaseScoringBatch(prisma: PrismaClient, batchId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "ScoringBatch" WHERE id = ${batchId} FOR UPDATE
    `;
    if (!batch || !['exported', 'superseded'].includes(batch.status)) throw new Error('only a nonterminal batch can be released');
    await tx.scoringBatchItem.updateMany({
      where: { batchId, status: 'leased' },
      data: { status: 'released', releasedAt: now },
    });
    return tx.scoringBatch.update({
      where: { id: batchId },
      data: { status: 'released', releasedAt: now },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function batchPreviewHash(preview: unknown): string {
  return canonicalJsonSha256(preview);
}
