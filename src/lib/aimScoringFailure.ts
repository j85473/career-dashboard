import { Prisma, type AimScoringFailureReceipt, type PrismaClient } from '@prisma/client';

import {
  aimBuilderFailureResolutionIdentity,
  aimExtractionFailureResolutionIdentity,
  aimFailureRetrySeriesKey,
  aimFailureSuppressionKey,
} from './aimIdentity';
import { createScoringBatchInTransaction, type CreateScoringBatchInput } from './scoringBatch';
import { canonicalJsonSha256, normalizeScoringText } from './scoringCanonicalJson';

export const AIM_SAFE_FAILURE_CODES = [
  'source_unusable',
  'input_contract_limit_exceeded',
  'model_context_limit_exceeded',
  'worker_invocation_failed',
  'packet_invalid',
  'evidence_invalid',
  'fact_extraction_conflict',
  'extraction_identity_vector_conflict',
] as const;

export type AimSafeFailureCode = typeof AIM_SAFE_FAILURE_CODES[number];
export type AimFailurePermanence = 'transient' | 'input_bound';
export type AimFailurePhase =
  | 'export_validation'
  | 'local_policy'
  | 'model_input_preflight'
  | 'stage1'
  | 'compensation_preflight'
  | 'complete_extraction'
  | 'holistic_scoring'
  | 'result_builder';

export type AimFailureIdentityInput = {
  jobId: string;
  inputHash: string;
  extractionIdentity: string;
  runnerProtocolHash: string;
  scoringPolicyHash: string;
  resultBuilderSemanticVersion: string;
  code: AimSafeFailureCode;
};

export type AimFailureSnapshot = {
  schemaVersion: 'aim-failure-snapshot-v1';
  code: AimSafeFailureCode;
  phase: AimFailurePhase;
  packetOrdinal: number | null;
  attempts: number;
  permanence: AimFailurePermanence;
  retrySeriesKey: string;
  suppressionKey: string;
  detail: string;
};

const INPUT_BOUND_CODES = new Set<AimSafeFailureCode>([
  'source_unusable',
  'input_contract_limit_exceeded',
  'model_context_limit_exceeded',
  'extraction_identity_vector_conflict',
]);

export function aimFailurePermanence(code: AimSafeFailureCode): AimFailurePermanence {
  return INPUT_BOUND_CODES.has(code) ? 'input_bound' : 'transient';
}

export function failureResolutionIdentity(input: AimFailureIdentityInput): string {
  return input.code === 'extraction_identity_vector_conflict'
    ? aimBuilderFailureResolutionIdentity({
      inputHash: input.inputHash,
      extractionIdentity: input.extractionIdentity,
      scoringPolicyHash: input.scoringPolicyHash,
      resultBuilderSemanticVersion: input.resultBuilderSemanticVersion,
      runnerProtocolHash: input.runnerProtocolHash,
    })
    : aimExtractionFailureResolutionIdentity({
      inputHash: input.inputHash,
      extractionIdentity: input.extractionIdentity,
      runnerProtocolHash: input.runnerProtocolHash,
    });
}

export function aimFailureKeys(input: AimFailureIdentityInput): {
  failureResolutionIdentity: string;
  retrySeriesKey: string;
  suppressionKey: string;
  permanence: AimFailurePermanence;
} {
  const permanence = aimFailurePermanence(input.code);
  const resolution = failureResolutionIdentity(input);
  const retrySeriesKey = aimFailureRetrySeriesKey({
    jobId: input.jobId,
    failureResolutionIdentity: resolution,
    failureCode: input.code,
  });
  return {
    failureResolutionIdentity: resolution,
    retrySeriesKey,
    suppressionKey: aimFailureSuppressionKey({ retrySeriesKey, permanence }),
    permanence,
  };
}

const PRIVATE_DETAIL_TERMS = /(?:<supplied-material>|originalJd|supportingText|exactQuote|approval\s*token|security\s*secret|validator\s*(?:finding|internal)|raw\s*(?:prompt|output|jd))/iu;

export function normalizeAimFailureDetail(value: string): string {
  const normalized = normalizeScoringText(value).trim();
  if (!normalized || [...normalized].length > 2_000) throw new Error('Aim failure detail must contain 1–2,000 code points');
  if (PRIVATE_DETAIL_TERMS.test(normalized)) {
    throw new Error('Aim failure detail contains prohibited private or internal material');
  }
  return normalized;
}

type SuppressionReceipt = Pick<AimScoringFailureReceipt,
  'jobId' | 'inputHash' | 'extractionIdentity' | 'runnerProtocolHash' | 'failureCode'
  | 'retrySeriesKey' | 'suppressionKey' | 'suppressionActive' | 'clearedAt'>;

export function activeAimFailureSuppression(
  receipt: SuppressionReceipt,
  current: Omit<AimFailureIdentityInput, 'jobId' | 'code'>,
): boolean {
  if (!receipt.suppressionActive || receipt.clearedAt !== null || receipt.extractionIdentity === null) return false;
  if (receipt.jobId === '' || !AIM_SAFE_FAILURE_CODES.includes(receipt.failureCode as AimSafeFailureCode)) return false;
  const keys = aimFailureKeys({
    ...current,
    jobId: receipt.jobId,
    code: receipt.failureCode as AimSafeFailureCode,
  });
  return receipt.inputHash === current.inputHash
    && receipt.extractionIdentity === current.extractionIdentity
    && receipt.runnerProtocolHash === current.runnerProtocolHash
    && receipt.retrySeriesKey === keys.retrySeriesKey
    && receipt.suppressionKey === keys.suppressionKey;
}

export type RecordAimFailureInput = AimFailureIdentityInput & {
  tx: Prisma.TransactionClient;
  producedByBatchItemId: string;
  sourceIdentity: string;
  protocolVersion: string;
  phase: AimFailurePhase;
  packetOrdinal: number | null;
  attempts: number;
  detail: string;
  activateSuppression?: boolean;
};

export async function recordAimFailureReceipt(input: RecordAimFailureInput): Promise<AimScoringFailureReceipt> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 0 || input.attempts > 1) {
    throw new Error('Aim failure attempts must be zero or one');
  }
  if (input.packetOrdinal !== null && (!Number.isSafeInteger(input.packetOrdinal) || input.packetOrdinal < 0 || input.packetOrdinal > 160)) {
    throw new Error('Aim failure packet ordinal is invalid');
  }
  const keys = aimFailureKeys(input);
  const detail = normalizeAimFailureDetail(input.detail);
  const prior = await input.tx.aimScoringFailureReceipt.findMany({
    where: { jobId: input.jobId, retrySeriesKey: keys.retrySeriesKey },
    select: { seriesOrdinal: true },
    orderBy: { seriesOrdinal: 'desc' },
    take: 1,
  });
  const seriesOrdinal = (prior[0]?.seriesOrdinal ?? 0) + 1;
  const suppressionActive = input.activateSuppression === true
    || keys.permanence === 'input_bound'
    || seriesOrdinal >= 3;
  const failureSnapshot: AimFailureSnapshot = {
    schemaVersion: 'aim-failure-snapshot-v1',
    code: input.code,
    phase: input.phase,
    packetOrdinal: input.packetOrdinal,
    attempts: input.attempts,
    permanence: keys.permanence,
    retrySeriesKey: keys.retrySeriesKey,
    suppressionKey: keys.suppressionKey,
    detail,
  };
  const failureReceiptHash = canonicalJsonSha256({
    kind: 'aim_failure_receipt_v1',
    jobId: input.jobId,
    producedByBatchItemId: input.producedByBatchItemId,
    sourceIdentity: input.sourceIdentity,
    extractionIdentity: input.extractionIdentity,
    inputHash: input.inputHash,
    failureResolutionIdentity: keys.failureResolutionIdentity,
    protocolVersion: input.protocolVersion,
    runnerProtocolHash: input.runnerProtocolHash,
    failureCode: input.code,
    permanence: keys.permanence,
    retrySeriesKey: keys.retrySeriesKey,
    suppressionKey: keys.suppressionKey,
    suppressionActive,
    seriesOrdinal,
    failureSnapshot,
  });
  return input.tx.aimScoringFailureReceipt.create({
    data: {
      jobId: input.jobId,
      producedByBatchItemId: input.producedByBatchItemId,
      sourceIdentity: input.sourceIdentity,
      extractionIdentity: input.extractionIdentity,
      inputHash: input.inputHash,
      failureResolutionIdentity: keys.failureResolutionIdentity,
      protocolVersion: input.protocolVersion,
      runnerProtocolHash: input.runnerProtocolHash,
      failureCode: input.code,
      permanence: keys.permanence,
      retrySeriesKey: keys.retrySeriesKey,
      suppressionKey: keys.suppressionKey,
      suppressionActive,
      seriesOrdinal,
      failureReceiptHash,
      failureSnapshot: failureSnapshot as unknown as Prisma.InputJsonValue,
    },
  });
}

export type CreateAimFailureRetryInput = {
  failureReceiptId: string;
  operatorReason: string;
  buildBatchInput: (
    tx: Prisma.TransactionClient,
    receipt: AimScoringFailureReceipt,
  ) => Promise<CreateScoringBatchInput>;
};

export async function createAimFailureRetryBatch(prisma: PrismaClient, input: CreateAimFailureRetryInput) {
  const reason = normalizeScoringText(input.operatorReason).trim();
  if (!reason || [...reason].length > 500) throw new Error('manual Aim retry reason must contain 1–500 code points');
  return prisma.$transaction(async (tx) => {
    const [lockedReceipt] = await tx.$queryRaw<AimScoringFailureReceipt[]>(Prisma.sql`
      SELECT * FROM "AimScoringFailureReceipt" WHERE id = ${input.failureReceiptId} FOR UPDATE
    `);
    if (!lockedReceipt || !lockedReceipt.suppressionActive || lockedReceipt.clearedAt !== null) {
      throw new Error('Aim failure suppression is no longer active');
    }
    const [job] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "Job" WHERE id = ${lockedReceipt.jobId} FOR UPDATE
    `);
    if (!job) throw new Error('suppressed Aim job no longer exists');
    const leased = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "ScoringBatchItem" WHERE "jobId" = ${lockedReceipt.jobId} AND status = 'leased' FOR UPDATE
    `);
    if (leased.length > 0) throw new Error('suppressed Aim job already has an active scoring lease');
    const nonterminal = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "ScoringBatch" WHERE stage = 'aim' AND status IN ('exported', 'superseded') FOR UPDATE
    `);
    if (nonterminal.length > 0) throw new Error('Aim already has a nonterminal scoring batch');

    const batchInput = await input.buildBatchInput(tx, lockedReceipt);
    if (batchInput.stage !== 'aim' || batchInput.schemaVersion !== 'career-dashboard-aim-export-v2' || batchInput.items.length !== 1) {
      throw new Error('manual Aim retry must create one exact v2 Aim item');
    }
    const [item] = batchInput.items;
    if (item.jobId !== lockedReceipt.jobId) throw new Error('manual Aim retry job does not match its failure receipt');
    item.manualRetryOfFailureReceiptId = lockedReceipt.id;
    item.manualRetryReason = reason;
    return createScoringBatchInTransaction(tx, batchInput);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
