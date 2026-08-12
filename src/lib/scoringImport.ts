import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient, type ScoringBatch, type ScoringBatchItem } from '@prisma/client';

import { validateCleanedJdArtifact, type CleanedJdArtifactInput, CLEANED_JD_ARTIFACT_SCHEMA_VERSION } from './scoringArtifact';
import { createScoringApprovalToken, verifyScoringApprovalToken } from './scoringApproval';
import { assertExactCodePointQuote, canonicalJsonSha256 } from './scoringCanonicalJson';
import { deriveExperienceDecision, type ExperienceCriterionSummary, type ScoringCriterionOutcome } from './scoringCriteria';
import { parseScoringExchangeJson, validateResultAgainstExport } from './scoringExchange';
import { AIM_HARD_STOP_CODES, AIM_RUBRIC_POINTS, deriveAimDecision, type AimHardStopCode, type AimHardStopState, type AimRubricBands } from './scoringPolicy';
import { refreshEvidenceGapReport } from './candidateEvidenceGaps';
import { recordJobPipelineEvent } from './ingestionControl';

type JsonRecord = Record<string, unknown>;
type LoadedBatch = ScoringBatch & { items: ScoringBatchItem[] };

export type ScoringImportProjection = {
  jobId: string;
  ordinal: number;
  decision: 'survivor' | 'rejected_hard_stop' | 'qualified' | 'hard_requirement_not_fully_supported' | 'safe_failure';
  score: number | null;
  applicable: boolean;
  detail: string;
  proposedStatus?: string;
  currentStatus?: string;
  lifecycleAction?: 'apply' | 'preserve_protected';
};

export type ScoringImportPreview = {
  version: 1;
  batchId: string;
  stage: 'aim' | 'experience';
  resultHash: string;
  applicable: boolean;
  itemCount: number;
  expectedCount: number;
  suppliedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  safeFailureCount: number;
  cannotEvaluateCount: number;
  doesNotMeetCount: number;
  protectedLifecycleCount: number;
  scoreRange: { minimum: number; maximum: number } | null;
  decisionCounts: Record<string, number>;
  projections: ScoringImportProjection[];
};

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function integerOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer or null`);
  return value as number;
}

function aimProjection(item: JsonRecord): ScoringImportProjection {
  const result = record(item.result, 'Aim item result');
  if (result.kind === 'safe_failure') {
    return { jobId: string(item.jobId, 'jobId'), ordinal: Number(item.ordinal), decision: 'safe_failure', score: null, applicable: false, detail: string(result.detail, 'safe failure detail') };
  }
  const hardStopRecords = array(result.hardStops, 'hardStops').map((value) => record(value, 'hard stop'));
  if (hardStopRecords.length !== AIM_HARD_STOP_CODES.length) throw new Error('Aim result must assess every hard stop exactly once');
  const hardStops = {} as Record<AimHardStopCode, AimHardStopState>;
  for (const hardStop of hardStopRecords) {
    const code = string(hardStop.code, 'hard stop code') as AimHardStopCode;
    if (!AIM_HARD_STOP_CODES.includes(code) || code in hardStops) throw new Error(`duplicate or unknown hard stop ${code}`);
    hardStops[code] = string(hardStop.state, 'hard stop state') as AimHardStopState;
  }
  let rubric: AimRubricBands | null = null;
  if (result.rubric !== null) {
    const rawRubric = record(result.rubric, 'Aim rubric');
    rubric = {} as AimRubricBands;
    for (const category of Object.keys(AIM_RUBRIC_POINTS) as Array<keyof typeof AIM_RUBRIC_POINTS>) {
      const bandRecord = record(rawRubric[category], `Aim rubric ${category}`);
      const band = string(bandRecord.band, `Aim rubric ${category} band`);
      const expectedPoints = (AIM_RUBRIC_POINTS[category] as Record<string, number>)[band];
      if (expectedPoints === undefined || bandRecord.points !== expectedPoints) throw new Error(`Aim rubric ${category} points mismatch`);
      rubric[category] = band as never;
    }
  }
  const recomputed = deriveAimDecision({ hardStops, rubric });
  if (result.decision !== recomputed.decision || integerOrNull(result.aimFitScore, 'aimFitScore') !== recomputed.aimFitScore) throw new Error('Aim decision or score mismatch');
  const travel = record(result.travel, 'travel assessment');
  if (rubric && (travel.band !== rubric.travel || travel.points !== AIM_RUBRIC_POINTS.travel[rubric.travel])) throw new Error('travel assessment and Aim rubric are conflated or mismatched');
  return {
    jobId: string(item.jobId, 'jobId'), ordinal: Number(item.ordinal), decision: recomputed.decision,
    score: recomputed.aimFitScore, applicable: true,
    detail: recomputed.hardStopCodes.length ? recomputed.hardStopCodes.join(', ') : 'ungated Aim survivor',
  };
}

function verifyEvidenceBindings(outcome: JsonRecord, evidenceById: Map<string, JsonRecord>): void {
  const state = string(outcome.outcome, 'leaf outcome') as ScoringCriterionOutcome;
  const support = array(outcome.support, 'support').map((value) => record(value, 'support binding'));
  const conflict = array(outcome.conflict, 'conflict').map((value) => record(value, 'conflict binding'));
  if ((state === 'direct' || state === 'partial') !== (support.length > 0)) throw new Error(`outcome ${state} has invalid support cardinality`);
  if ((state === 'does_not_meet') !== (conflict.length > 0)) throw new Error(`outcome ${state} has invalid conflict cardinality`);
  if (state === 'cannot_evaluate' && (support.length || conflict.length)) throw new Error('cannot_evaluate cannot fabricate evidence');
  for (const binding of [...support, ...conflict]) {
    const evidence = evidenceById.get(string(binding.evidenceId, 'evidenceId'));
    if (!evidence) throw new Error('evidence binding references an unknown evidence ID');
    const fieldPath = string(binding.fieldPath, 'fieldPath');
    const source = evidence[fieldPath];
    if (typeof source !== 'string') throw new Error('evidence binding references a non-text field');
    assertExactCodePointQuote(source, {
      startCodePoint: Number(binding.startCodePoint), endCodePoint: Number(binding.endCodePoint),
    }, string(binding.exactQuote, 'evidence exactQuote'));
    if ((support.includes(binding) && !['supports_complete', 'supports_partial'].includes(String(binding.relation))) || (conflict.includes(binding) && binding.relation !== 'conflicts')) throw new Error('evidence relation is incompatible with its outcome field');
  }
}

function experienceProjection(item: JsonRecord, exported: JsonRecord): ScoringImportProjection {
  const result = record(item.result, 'Experience item result');
  if (result.kind === 'safe_failure') {
    return { jobId: string(item.jobId, 'jobId'), ordinal: Number(item.ordinal), decision: 'safe_failure', score: null, applicable: false, detail: string(result.detail, 'safe failure detail') };
  }
  const exportEvidence = record(exported.evidence, 'Experience export evidence');
  const evidenceById = new Map(array(exportEvidence.records, 'evidence records').map((value) => {
    const evidence = record(value, 'evidence record');
    return [string(evidence.evidenceId, 'evidenceId'), evidence];
  }));
  const criteria = array(result.criteria, 'criteria').map((value) => record(value, 'criterion'));
  const outcomes = array(result.outcomes, 'outcomes').map((value) => record(value, 'criterion outcome'));
  if (criteria.length !== outcomes.length) throw new Error('Experience criteria/outcome coverage mismatch');
  const outcomesById = new Map(outcomes.map((outcome) => [string(outcome.criterionId, 'criterion outcome ID'), outcome]));
  const summaries: ExperienceCriterionSummary[] = criteria.map((criterion) => {
    const criterionId = string(criterion.criterionId, 'criterionId');
    const outcome = outcomesById.get(criterionId);
    if (!outcome) throw new Error(`missing outcome for ${criterionId}`);
    const sourceLeaves = array(criterion.leaves, 'criterion leaves').map((value) => record(value, 'criterion leaf'));
    const leafOutcomes = array(outcome.leaves, 'leaf outcomes').map((value) => record(value, 'leaf outcome'));
    if (sourceLeaves.length !== leafOutcomes.length) throw new Error(`leaf outcome coverage mismatch for ${criterionId}`);
    const leaves = sourceLeaves.map((leaf, index) => {
      const assessed = leafOutcomes[index];
      if (leaf.leafId !== assessed.leafId) throw new Error(`leaf order mismatch for ${criterionId}`);
      verifyEvidenceBindings(assessed, evidenceById);
      return { leafId: string(assessed.leafId, 'leafId'), outcome: string(assessed.outcome, 'leaf outcome') as ScoringCriterionOutcome };
    });
    return {
      criterionId,
      classification: string(criterion.classification, 'classification') as ExperienceCriterionSummary['classification'],
      category: string(criterion.category, 'category') as ExperienceCriterionSummary['category'],
      operator: string(criterion.operator, 'operator') as ExperienceCriterionSummary['operator'],
      leaves,
      declaredOutcome: string(outcome.outcome, 'top-level outcome') as ExperienceCriterionSummary['declaredOutcome'],
    };
  });
  if (outcomesById.size !== summaries.length) throw new Error('Experience result has duplicate or extra criterion outcomes');
  const recomputed = deriveExperienceDecision(summaries);
  if (result.decision !== recomputed.decision || integerOrNull(result.experienceFitScore, 'experienceFitScore') !== recomputed.experienceFitScore || integerOrNull(result.preferredPoints, 'preferredPoints') !== recomputed.preferredPoints) throw new Error('Experience decision or score mismatch');
  const blocking = array(result.blockingCriteria, 'blockingCriteria').map((value) => record(value, 'blocking criterion'));
  if (canonicalJsonSha256(blocking) !== canonicalJsonSha256(recomputed.blockingCriteria)) throw new Error('Experience blocking criteria mismatch');
  return {
    jobId: string(item.jobId, 'jobId'), ordinal: Number(item.ordinal), decision: recomputed.decision,
    score: recomputed.experienceFitScore, applicable: true,
    detail: recomputed.explanation,
  };
}

export function buildScoringImportPreview(batch: LoadedBatch, payload: JsonRecord): ScoringImportPreview {
  const exported = parseScoringExchangeJson(batch.exportJson);
  validateResultAgainstExport(payload, exported);
  if (record(payload.batch, 'result batch').id !== batch.id || record(payload.batch, 'result batch').manifestHash !== batch.manifestHash) throw new Error('result does not bind the stored batch');
  if (batch.status === 'released' || batch.status === 'superseded') throw new Error(`batch status ${batch.status} is not importable`);
  if (batch.status === 'exported' && batch.expiresAt.valueOf() <= Date.now()) throw new Error('expired batch requires explicit extension or release');
  const resultItems = array(payload.results, 'results').map((value) => record(value, 'result item'));
  const projections = resultItems.map((item) => batch.stage === 'aim' ? aimProjection(item) : experienceProjection(item, exported));
  const decisionCounts: Record<string, number> = {};
  for (const projection of projections) decisionCounts[projection.decision] = (decisionCounts[projection.decision] || 0) + 1;
  const outcomes = batch.stage === 'experience'
    ? resultItems.flatMap((item) => {
      const result = record(item.result, 'Experience item result');
      return result.kind === 'evaluation' ? array(result.outcomes, 'outcomes').map((value) => record(value, 'outcome')) : [];
    })
    : [];
  const scores = projections.flatMap((projection) => projection.score === null ? [] : [projection.score]);
  const acceptedCount = projections.filter((projection) => projection.applicable).length;
  return {
    version: 1, batchId: batch.id, stage: batch.stage as 'aim' | 'experience', resultHash: string(payload.resultHash, 'resultHash'),
    applicable: acceptedCount === projections.length,
    itemCount: projections.length,
    expectedCount: batch.items.length,
    suppliedCount: resultItems.length,
    acceptedCount,
    rejectedCount: projections.length - acceptedCount,
    safeFailureCount: projections.filter((projection) => projection.decision === 'safe_failure').length,
    cannotEvaluateCount: outcomes.filter((outcome) => outcome.outcome === 'cannot_evaluate').length,
    doesNotMeetCount: outcomes.filter((outcome) => outcome.outcome === 'does_not_meet').length,
    protectedLifecycleCount: 0,
    scoreRange: scores.length ? { minimum: Math.min(...scores), maximum: Math.max(...scores) } : null,
    decisionCounts,
    projections,
  };
}

function proposedStatus(projection: ScoringImportProjection): string {
  if (projection.decision === 'survivor') return 'pending_af';
  if (projection.decision === 'qualified') return 'inbox';
  return 'dismissed';
}

function bindLifecyclePreview(
  preview: ScoringImportPreview,
  batch: LoadedBatch,
  jobs: Array<{ id: string; updatedAt: Date; status: string; tailoringStaged: boolean }>,
): ScoringImportPreview {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const submittedByJob = new Map(batch.items.map((item) => [item.jobId, item.submittedUpdatedAt.valueOf()]));
  return {
    ...preview,
    protectedLifecycleCount: preview.projections.filter((projection) => {
      const job = jobsById.get(projection.jobId);
      return Boolean(job && lifecycleProtected(job));
    }).length,
    projections: preview.projections.map((projection) => {
      const job = jobsById.get(projection.jobId);
      if (!job) throw new Error(`job ${projection.jobId} no longer exists`);
      if (job.updatedAt.valueOf() !== submittedByJob.get(job.id)) throw new Error(`job ${job.id} changed after export`);
      const protectedLifecycle = lifecycleProtected(job);
      return {
        ...projection,
        proposedStatus: proposedStatus(projection),
        currentStatus: job.status,
        lifecycleAction: protectedLifecycle ? 'preserve_protected' : 'apply',
      };
    }),
  };
}

export async function previewScoringImport(prisma: PrismaClient, rawPayload: string | Buffer, options: { approvalSecret?: string } = {}) {
  const payload = parseScoringExchangeJson(rawPayload);
  const resultBatch = record(payload.batch, 'result batch');
  const batch = await prisma.scoringBatch.findUnique({ where: { id: string(resultBatch.id, 'batch ID') }, include: { items: { orderBy: { ordinal: 'asc' } } } });
  if (!batch) throw new Error('scoring batch not found');
  let preview = buildScoringImportPreview(batch, payload);
  if (batch.status === 'completed') {
    if (batch.acceptedResultHash !== preview.resultHash) throw new Error('completed batch rejects divergent replay');
    return {
      preview,
      approvalToken: null,
      approvalExpiresAt: null,
      receipt: { batchId: batch.id, resultHash: preview.resultHash, idempotentReplay: true, imported: batch.items.length },
    };
  }
  const jobs = await prisma.job.findMany({
    where: { id: { in: batch.items.map((item) => item.jobId) } },
    select: { id: true, updatedAt: true, status: true, tailoringStaged: true },
  });
  preview = bindLifecyclePreview(preview, batch, jobs);
  const approval = preview.applicable
    ? createScoringApprovalToken({ batchId: batch.id, resultHash: preview.resultHash, preview }, { secret: options.approvalSecret })
    : null;
  return { preview, approvalToken: approval?.token || null, approvalExpiresAt: approval?.claims.expiresAt || null };
}

function lifecycleProtected(job: { status: string; tailoringStaged: boolean }): boolean {
  return job.tailoringStaged || ['inbox', 'passed', 'dismissed', 'bookmarked', 'applied', 'interviewing', 'expired', 'archived', 'cooldown'].includes(job.status);
}

export async function applyScoringImport(
  prisma: PrismaClient,
  rawPayload: string | Buffer,
  approvalToken: string,
  options: { approvalSecret?: string; now?: Date; injectFailureAfterItems?: number } = {},
) {
  const payload = parseScoringExchangeJson(rawPayload);
  const payloadBatch = record(payload.batch, 'result batch');
  const batchId = string(payloadBatch.id, 'batch ID');
  const resultHash = string(payload.resultHash, 'resultHash');
  const now = options.now || new Date();

  const applied = await prisma.$transaction(async (tx) => {
    const [lockedBatch] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ScoringBatch" WHERE id = ${batchId} FOR UPDATE`;
    if (!lockedBatch) throw new Error('scoring batch not found');
    const batch = await tx.scoringBatch.findUnique({ where: { id: batchId }, include: { items: { orderBy: { ordinal: 'asc' } } } });
    if (!batch) throw new Error('scoring batch not found');
    if (batch.status === 'completed') {
      if (batch.acceptedResultHash !== resultHash) throw new Error('completed batch rejects divergent replay');
      return { batchId, resultHash, idempotentReplay: true, imported: batch.items.length };
    }
    let preview = buildScoringImportPreview(batch, payload);
    if (!preview.applicable) throw new Error('safe failure makes the whole batch non-applicable');
    const lockedJobs = await tx.$queryRaw<Array<{ id: string; updatedAt: Date }>>(Prisma.sql`
      SELECT id, "updatedAt" FROM "Job" WHERE id IN (${Prisma.join(batch.items.map((item) => item.jobId))}) FOR UPDATE
    `);
    const updatedAtByJob = new Map(lockedJobs.map((job) => [job.id, job.updatedAt.valueOf()]));
    for (const item of batch.items) if (updatedAtByJob.get(item.jobId) !== item.submittedUpdatedAt.valueOf()) throw new Error(`job ${item.jobId} changed after export`);
    const lifecycleJobs = await tx.job.findMany({
      where: { id: { in: batch.items.map((item) => item.jobId) } },
      select: { id: true, updatedAt: true, status: true, tailoringStaged: true },
    });
    preview = bindLifecyclePreview(preview, batch, lifecycleJobs);
    verifyScoringApprovalToken(approvalToken, { batchId, resultHash, preview }, { now, secret: options.approvalSecret });

    const resultItems = array(payload.results, 'results').map((value) => record(value, 'result item'));
    const runner = record(payload.runner, 'runner provenance');
    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index];
      const rawItem = resultItems[index];
      const evaluated = record(rawItem.result, 'result');
      const projection = preview.projections[index];
      const job = await tx.job.findUniqueOrThrow({ where: { id: item.jobId }, select: { status: true, tailoringStaged: true, source: true, sourceId: true } });
      const protectedLifecycle = lifecycleProtected(job);
      let artifactId: string | null = item.cleanedArtifactId;

      if (batch.stage === 'aim') {
        const artifact = record(evaluated.cleanedArtifact, 'cleaned artifact') as unknown as CleanedJdArtifactInput;
        const sourceSnapshot = record(item.inputSnapshot, 'Aim input snapshot');
        const sourceJd = string(sourceSnapshot.originalJd, 'original JD');
        const validatedArtifact = validateCleanedJdArtifact(sourceJd, artifact);
        artifactId = randomUUID();
        await tx.jobScoringArtifact.create({ data: {
          id: artifactId, jobId: item.jobId, kind: 'cleaned_jd', schemaVersion: CLEANED_JD_ARTIFACT_SCHEMA_VERSION,
          cleanerVersion: artifact.cleanerVersion, sourceJdHash: artifact.sourceJdHash, contentHash: validatedArtifact.contentHash,
          cleanedText: artifact.cleanedText, removedSpans: artifact.removedSpans as unknown as Prisma.InputJsonValue,
          coverageAudit: artifact.coverageAudit as unknown as Prisma.InputJsonValue, repairHistory: artifact.repairHistory as unknown as Prisma.InputJsonValue,
          producedByBatchItemId: item.id,
        } });
      }

      const eventId = randomUUID();
      const travelAssessment = batch.stage === 'aim' ? record(evaluated.travel, 'travel') : null;
      const travelDisplayCache = travelAssessment
        ? integerOrNull(travelAssessment.maximumPercent, 'travel maximumPercent') ?? integerOrNull(travelAssessment.minimumPercent, 'travel minimumPercent')
        : null;
      const proposedStatus = batch.stage === 'aim'
        ? (projection.decision === 'rejected_hard_stop' ? 'dismissed' : 'pending_af')
        : (projection.decision === 'qualified' ? 'inbox' : 'dismissed');
      await tx.jobScoreEvent.create({ data: {
        id: eventId, jobId: item.jobId, evaluationType: batch.stage === 'aim' ? 'aim_fit' : 'experience_fit',
        model: string(runner.model, 'runner model'), promptVersion: string(runner.promptVersion, 'runner prompt version'), policyVersion: batch.policyVersion,
        schemaVersion: batch.schemaVersion, batchId: batch.id, batchItemId: item.id, manifestHash: batch.manifestHash,
        inputHash: item.inputHash, resultHash: string(rawItem.resultHash, 'item resultHash'), evidenceHash: batch.evidenceHash,
        sourceAimEventId: item.sourceAimEventId, cleanedJdArtifactId: artifactId, decisionCode: projection.decision,
        aimAssessments: batch.stage === 'aim' ? evaluated as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
        mandatoryRequirementAssessments: batch.stage === 'experience' ? evaluated as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
        travelAssessment: travelAssessment ? travelAssessment as Prisma.InputJsonValue : Prisma.JsonNull,
        compensationAssessment: batch.stage === 'aim' ? record(evaluated.compensation, 'compensation') as Prisma.InputJsonValue : Prisma.JsonNull,
        inputBindings: item.inputSnapshot as unknown as Prisma.InputJsonValue,
        workerProvenance: { runner, workers: array(rawItem.workers, 'worker provenance') } as unknown as Prisma.InputJsonValue,
        lifecycleProjection: proposedStatus,
        aimFitScore: batch.stage === 'aim' ? projection.score : null,
        experienceFitScore: batch.stage === 'experience' ? projection.score : null,
        // Deprecated display cache: disclosed percentage bound only. Aim preference points remain in aimAssessments.travel.points.
        travelScore: batch.stage === 'aim' ? travelDisplayCache : null,
        passed: projection.decision === 'survivor' || projection.decision === 'qualified',
        aimReason: batch.stage === 'aim' ? projection.detail : null, experienceReason: batch.stage === 'experience' ? projection.detail : null,
      } });
      await tx.scoringBatchItem.update({ where: { id: item.id }, data: {
        status: 'imported', importedAt: now, acceptedResultHash: string(rawItem.resultHash, 'item resultHash'),
        acceptedResultSnapshot: rawItem as Prisma.InputJsonValue, importedScoreEventId: eventId,
        cleanedArtifactId: artifactId,
      } });
      await tx.job.update({ where: { id: item.jobId }, data: {
        ...(batch.stage === 'aim' ? { aimFitScore: projection.score, travelScore: travelDisplayCache } : { reqFitScore: projection.score }),
        ...(!protectedLifecycle ? { status: proposedStatus } : {}),
      } });
      if (batch.stage === 'experience') {
        await recordJobPipelineEvent({
          eventType: projection.decision === 'qualified' ? 'ae_pass' : 'ae_reject',
          jobId: item.jobId,
          stage: 'experience_fit',
          source: job.source,
          sourceId: job.sourceId,
          occurredAt: now,
          identityParts: ['manual_scoring_import', eventId],
          details: {
            scoreEventId: eventId,
            batchId: batch.id,
            decision: projection.decision,
            enteredInbox: projection.decision === 'qualified' && !protectedLifecycle,
            actor: 'machine',
            protected: false,
          },
        }, tx);
      }
      if (options.injectFailureAfterItems === index + 1) throw new Error('injected scoring import failure');
    }
    await tx.scoringBatch.update({ where: { id: batch.id }, data: { status: 'completed', completedAt: now, acceptedResultHash: resultHash } });
    return { batchId, resultHash, idempotentReplay: false, imported: batch.items.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (payloadBatch.stage !== 'experience' || applied.idempotentReplay) return applied;
  try {
    const evidenceGapRefresh = await refreshEvidenceGapReport(prisma);
    return { ...applied, evidenceGapRefresh, evidenceGapRefreshError: null };
  } catch (error) {
    return {
      ...applied,
      evidenceGapRefresh: null,
      evidenceGapRefreshError: error instanceof Error ? error.message : 'evidence-gap refresh failed',
    };
  }
}
