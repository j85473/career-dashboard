import { createHash, randomUUID } from 'node:crypto';

import {
  Prisma,
  type PrismaClient,
  type ScoringBatch,
  type ScoringBatchItem,
} from '@prisma/client';

import {
  aimFailureKeys,
  normalizeAimFailureDetail,
  recordAimFailureReceipt,
  type AimSafeFailureCode,
} from './aimScoringFailure';
import { buildAimResultFromFactualVector, type AimBuilderInput, type AimTerminalResult } from './aimResultBuilder';
import { loadAimQuestionRegistry } from './aimQuestionRegistry';
import { loadAimScoringPolicy } from './aimScoringPolicy';
import { isCurrentAimExperienceAnchor } from './aimStage1';
import type { AimFactualVector, AimPacketReceipt, AimScoringPolicy } from './aimV2Types';
import {
  aimBatchItemInputHash,
  aimSemanticResultHash,
  aimSourceJdHash,
  aimTrustedMetadataHash,
  normalizeAimTrustedMetadata,
} from './aimIdentity';
import { createScoringApprovalToken, verifyScoringApprovalToken } from './scoringApproval';
import { experienceScorePasses } from './experienceFit';
import {
  assertExactCodePointQuote,
  canonicalJson,
  canonicalJsonSha256,
  normalizeScoringText,
} from './scoringCanonicalJson';
import {
  deriveExperienceDecision,
  stableCriterionId,
  type ExperienceCriterionSummary,
  type ScoringCriterionOutcome,
} from './scoringCriteria';
import { recordJobPipelineEvent } from './ingestionControl';
import { parseScoringExchangeJson, validateResultAgainstExport } from './scoringExchange';
import { currentScoringInputVersions } from './scoringInputVersions';

type JsonRecord = Record<string, unknown>;
type LoadedBatch = ScoringBatch & { items: ScoringBatchItem[] };
type ImportDbClient = PrismaClient | Prisma.TransactionClient;

export type ScoringImportProjection = {
  jobId: string;
  ordinal: number;
  company?: string;
  title?: string;
  decision: string;
  variant: string;
  score: number | null;
  band?: string | null;
  applicable: boolean;
  detail: string;
  assessment?: unknown;
  proposedStatus?: string;
  currentStatus?: string;
  lifecycleAction?: 'apply' | 'preserve_protected' | 'action_needed';
  failureRetrySeriesKey?: string;
  failurePermanence?: 'transient' | 'input_bound';
  failureSeriesOrdinal?: number;
  suppressionActiveAfterApply?: boolean;
};

export type ScoringImportPreview = {
  version: 2;
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

export function actionNeededUpdateForScoringFailure(
  stage: 'aim' | 'experience',
  detail: string,
): Prisma.JobUpdateInput {
  const message = `${stage === 'aim' ? 'Aim Fit' : 'E Fit'} could not score this job: ${detail}`;
  return {
    scoringStatus: 'failed',
    scoreError: [...message].slice(0, 2_000).join(''),
  };
}

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

function aimDeterministicResult(result: JsonRecord): JsonRecord {
  const projected = structuredClone(result);
  if (recordOrNull(projected.factualVector)) {
    const semanticVector = { ...projected.factualVector as JsonRecord };
    delete semanticVector.provenance;
    delete semanticVector.runnerProtocolVersion;
    delete semanticVector.runnerProtocolHash;
    projected.factualVector = semanticVector;
  }
  return projected;
}

function recordOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

type AimWorkerEpisode = {
  packetOrdinal: number;
  packetPath: string;
  packetManifestHash: string;
  attempts: JsonRecord[];
};

function validateAimAttemptOutcome(attempt: JsonRecord, field: string): void {
  const outcome = string(attempt.outcome, `${field}.outcome`);
  const failureCategory = attempt.failureCategory;
  const expectedCategory = outcome === 'accepted' ? null
    : outcome === 'invocation_failed' ? 'invocation_failure'
      : outcome === 'output_invalid' ? 'output_invalid'
        : outcome === 'evidence_invalid' ? 'evidence_invalidity'
          : undefined;
  if (expectedCategory === undefined || failureCategory !== expectedCategory) {
    throw new Error(`${field} outcome/failure category is inconsistent`);
  }
  const startedAt = Date.parse(string(attempt.startedAt, `${field}.startedAt`));
  const completedAt = Date.parse(string(attempt.completedAt, `${field}.completedAt`));
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`${field} timestamps are inconsistent`);
  }
}

function finalizeAimWorkerEpisode(episode: AimWorkerEpisode): void {
  const accepted = episode.attempts.flatMap((attempt, index) => attempt.outcome === 'accepted' ? [index] : []);
  if (episode.attempts.length !== 1 || accepted.length > 1) {
    throw new Error('Aim worker episode accepted-attempt provenance is inconsistent');
  }
}

function aimWorkerEpisodes(workers: JsonRecord[]): AimWorkerEpisode[] {
  const episodes: AimWorkerEpisode[] = [];
  for (const [index, worker] of workers.entries()) {
    const packetOrdinal = Number(worker.packetOrdinal);
    const packetPath = string(worker.packetPath, `Aim worker ${index}.packetPath`);
    const packetManifestHash = string(worker.packetManifestHash, `Aim worker ${index}.packetManifestHash`);
    const attemptOrdinal = Number(worker.attemptOrdinal);
    if (!Number.isSafeInteger(packetOrdinal) || !Number.isSafeInteger(attemptOrdinal)) {
      throw new Error(`Aim worker ${index} ordinals must be integers`);
    }
    let active = episodes.at(-1);
    const samePacket = active !== undefined
      && active.packetOrdinal === packetOrdinal
      && active.packetPath === packetPath
      && active.packetManifestHash === packetManifestHash;
    if (!active || !samePacket || attemptOrdinal === 1) {
      if (active) finalizeAimWorkerEpisode(active);
      if (attemptOrdinal !== 1) throw new Error('Aim worker episode must start at attempt one');
      active = { packetOrdinal, packetPath, packetManifestHash, attempts: [] };
      episodes.push(active);
    } else {
      throw new Error('Aim worker packet was invoked more than once');
    }
    validateAimAttemptOutcome(worker, `Aim worker ${index}`);
    active.attempts.push(worker);
  }
  const finalEpisode = episodes.at(-1);
  if (finalEpisode) finalizeAimWorkerEpisode(finalEpisode);
  return episodes;
}

function assertAimReusePreserved(exportedReuse: JsonRecord, vector: AimFactualVector): void {
  const reused = record(exportedReuse.factualVector, 'Aim reused factual vector') as unknown as AimFactualVector;
  if (reused.extractionIdentity !== vector.extractionIdentity
    || exportedReuse.extractionIdentity !== vector.extractionIdentity
    || exportedReuse.factualVectorHash !== reused.factualVectorHash
    || exportedReuse.scope !== reused.scope) {
    throw new Error('Dashboard extraction reuse identity/vector binding is inconsistent');
  }
  const scopeRank = { stage1: 0, compensation_preflight: 1, complete: 2 } as const;
  if (scopeRank[vector.scope] < scopeRank[reused.scope]) throw new Error('Dashboard extraction reuse regressed its accepted scope');
  const answersById = new Map(vector.answers.map((answer) => [answer.questionId, answer]));
  for (const answer of reused.answers) {
    if (canonicalJson(answersById.get(answer.questionId)) !== canonicalJson(answer)) {
      throw new Error(`Dashboard extraction reuse changed accepted answer ${answer.questionId}`);
    }
  }
  const evidenceById = new Map(vector.evidenceCatalog.map((entry) => [entry.evidenceId, entry]));
  for (const evidence of reused.evidenceCatalog) {
    if (canonicalJson(evidenceById.get(evidence.evidenceId)) !== canonicalJson(evidence)) {
      throw new Error(`Dashboard extraction reuse changed accepted evidence ${evidence.evidenceId}`);
    }
  }
}

function validateAimWorkerBindings(
  item: JsonRecord,
  vector: AimFactualVector | null,
  exportedReuse: JsonRecord | null,
): void {
  const workers = array(item.workers, 'Aim workers').map((worker) => record(worker, 'Aim worker'));
  const factualWorkers = workers.filter((worker) => worker.effort === 'medium');
  const holisticWorkers = workers.filter((worker) => worker.effort === 'high');
  const episodes = aimWorkerEpisodes(factualWorkers);
  const result = record(item.result, 'Aim result');
  const expectedHolisticWorkers = result.variant === 'scored_survivor' ? 1 : 0;
  if (holisticWorkers.length !== expectedHolisticWorkers) {
    throw new Error('Aim result has an invalid holistic Stage 2 worker count');
  }
  if (holisticWorkers.some((worker) => worker.outcome !== 'accepted' || worker.failureCategory !== null)) {
    throw new Error('Aim scored result contains an unaccepted holistic Stage 2 worker');
  }
  if (!vector) {
    if (workers.length !== 0 && record(item.result, 'Aim result').variant === 'local_policy_kill') {
      throw new Error('Aim local-policy result must have zero worker calls');
    }
    if (record(item.result, 'Aim result').variant === 'local_policy_kill' && item.packetPlanHash !== null) {
      throw new Error('Aim local-policy result must not claim a packet plan');
    }
    return;
  }
  if (item.packetPlanHash !== vector.provenance.packetPlanHash) throw new Error('Aim item packet plan does not match its factual vector');
  if (exportedReuse) assertAimReusePreserved(exportedReuse, vector);
  if (exportedReuse && factualWorkers.length === 0) {
    assertCanonicalEqual(exportedReuse.factualVector, vector, 'zero-factual-call Dashboard reuse changed its stored factual vector');
    return;
  }
  if (exportedReuse && factualWorkers.length > 0) {
    if (vector.provenance.disposition !== 'dashboard_reuse'
      || vector.provenance.sourceExtractionId !== exportedReuse.aimFactualExtractionId) {
      throw new Error('Dashboard partial-vector continuation is missing its reuse provenance');
    }
    if (exportedReuse.scope === 'complete') throw new Error('Complete Dashboard extraction reuse cannot invoke workers');
  } else if (!exportedReuse && vector.provenance.disposition === 'dashboard_reuse') {
    throw new Error('Aim result claims Dashboard reuse that was not exported');
  }
  let priorPhysicalOrdinal = -1;
  const packetsByManifest = new Map<string, AimPacketReceipt>();
  for (const packet of vector.provenance.packets) {
    if (packet.physicalOrdinal <= priorPhysicalOrdinal) throw new Error('Aim factual-vector packets are not in physical order');
    priorPhysicalOrdinal = packet.physicalOrdinal;
    if (packetsByManifest.has(packet.packetManifestHash)) throw new Error('Aim factual-vector packet manifests are not unique');
    packetsByManifest.set(packet.packetManifestHash, packet);
    if (packet.attempts.some((attempt, index) => attempt.attemptOrdinal !== index + 1)) {
      throw new Error('Aim packet attempt ordinals are not contiguous');
    }
    packet.attempts.forEach((attempt, index) => validateAimAttemptOutcome(
      attempt as unknown as JsonRecord,
      `Aim factual-vector packet ${packet.physicalOrdinal} attempt ${index + 1}`,
    ));
    const accepted = packet.attempts.flatMap((attempt) => attempt.outcome === 'accepted' ? [attempt.attemptOrdinal] : []);
    if (accepted.length > 1 || (accepted.length === 1 && accepted[0] !== packet.attempts.at(-1)?.attemptOrdinal)
      || (packet.acceptedAttempt ?? null) !== (accepted[0] ?? null)) {
      throw new Error('Aim packet accepted-attempt provenance is inconsistent');
    }
    if (packet.reusedFromPacketManifestHash !== null && packet.attempts.length !== 0) {
      throw new Error('Aim reused packet cannot claim current invocation attempts');
    }
    if (packet.attempts.length === 0 && packet.reusedFromPacketManifestHash !== packet.packetManifestHash) {
      throw new Error('Aim zero-attempt packet is missing exact checkpoint-reuse provenance');
    }
  }
  const lastEpisodeByManifest = new Map<string, AimWorkerEpisode>();
  for (const episode of episodes) {
    const packet = packetsByManifest.get(episode.packetManifestHash);
    if (!packet || packet.physicalOrdinal !== episode.packetOrdinal || packet.packetPath !== episode.packetPath) {
      throw new Error('Aim worker does not bind a factual-vector packet');
    }
    if (episode.attempts.at(-1)?.outcome !== 'accepted') {
      throw new Error('Aim terminal result contains an exhausted worker episode');
    }
    if (lastEpisodeByManifest.has(episode.packetManifestHash)) {
      throw new Error('Aim worker packet was invoked more than once');
    }
    lastEpisodeByManifest.set(episode.packetManifestHash, episode);
  }
  for (const [manifest, episode] of lastEpisodeByManifest) {
    const packet = packetsByManifest.get(manifest)!;
    const expected = packet.attempts.map((attempt) => ({
      packetOrdinal: packet.physicalOrdinal,
      packetPath: packet.packetPath,
      packetManifestHash: packet.packetManifestHash,
      ...attempt,
    }));
    if (canonicalJson(episode.attempts) !== canonicalJson(expected)) {
      throw new Error('Aim current worker provenance does not match the final accepted packet receipt');
    }
  }
  for (const packet of vector.provenance.packets) {
    if (packet.attempts.length > 0 && !lastEpisodeByManifest.has(packet.packetManifestHash)) {
      throw new Error('Aim fresh packet receipt is missing from current workers');
    }
  }
}

function validateAimSafeFailureWorkerBindings(item: JsonRecord, result: JsonRecord): void {
  const code = string(result.code, 'Aim failure code') as AimSafeFailureCode;
  const phase = string(result.phase, 'Aim failure phase');
  const packetOrdinal = integerOrNull(result.packetOrdinal, 'Aim failure packetOrdinal');
  const attempts = Number(result.attempts);
  const packetPlanHash = item.packetPlanHash;
  const episodes = aimWorkerEpisodes(array(item.workers, 'Aim workers').map((worker) => record(worker, 'Aim worker')));
  const noCallPreflight = ['source_unusable'] as const;
  if (noCallPreflight.includes(code as typeof noCallPreflight[number])) {
    if (phase !== 'model_input_preflight' || packetOrdinal !== null || attempts !== 0
      || packetPlanHash !== null || episodes.length !== 0) {
      throw new Error(`Aim ${code} failure has impossible worker provenance`);
    }
    return;
  }
  if (code === 'extraction_identity_vector_conflict') {
    if (phase !== 'result_builder' || packetOrdinal !== null || attempts !== 0
      || packetPlanHash !== null || episodes.length !== 0) {
      throw new Error('Aim extraction identity/vector conflict has impossible worker provenance');
    }
    return;
  }
  const packetFailureOutcome = code === 'worker_invocation_failed' ? ['invocation_failed', 'invocation_failure']
    : code === 'packet_invalid' ? ['output_invalid', 'output_invalid']
      : code === 'evidence_invalid' ? ['evidence_invalid', 'evidence_invalidity']
        : null;
  if (packetFailureOutcome) {
    if (!['stage1', 'compensation_preflight', 'complete_extraction', 'holistic_scoring'].includes(phase)
      || packetOrdinal === null || attempts !== 1 || typeof packetPlanHash !== 'string') {
      throw new Error(`Aim ${code} failure has impossible packet provenance`);
    }
    const failed = episodes.filter((episode) => episode.packetOrdinal === packetOrdinal).at(-1);
    const finalAttempt = failed?.attempts.at(-1);
    if (!failed || failed.attempts.length !== attempts
      || finalAttempt?.outcome !== packetFailureOutcome[0]
      || finalAttempt.failureCategory !== packetFailureOutcome[1]) {
      throw new Error(`Aim ${code} failure does not bind its exhausted packet`);
    }
    return;
  }
  if (packetOrdinal !== null || attempts !== 0) throw new Error(`Aim ${code} failure cannot claim packet attempts`);
  if (episodes.some((episode) => episode.attempts.at(-1)?.outcome !== 'accepted')) {
    throw new Error(`Aim ${code} failure contains an unrelated exhausted packet`);
  }
  if (code === 'fact_extraction_conflict') {
    if (phase !== 'result_builder' || typeof packetPlanHash !== 'string' || episodes.length === 0) {
      throw new Error('Aim fact-extraction conflict has impossible worker provenance');
    }
    return;
  }
  if (code === 'model_context_limit_exceeded') {
    if (phase !== 'model_input_preflight') throw new Error('Aim model-context failure has impossible phase');
    return;
  }
  if (code === 'input_contract_limit_exceeded') {
    if (!['model_input_preflight', 'result_builder'].includes(phase)) {
      throw new Error('Aim input-contract failure has impossible phase');
    }
    return;
  }
  throw new Error(`unsupported Aim safe-failure provenance code ${code}`);
}

type AimProjectionContext = {
  item: JsonRecord;
  exportJob: JsonRecord;
  exportBatch: JsonRecord;
  registry: ReturnType<typeof loadAimQuestionRegistry>['registry'];
  policy: AimScoringPolicy;
};

function aimProjection(context: AimProjectionContext): ScoringImportProjection {
  const { item, exportJob, exportBatch, registry, policy } = context;
  const result = record(item.result, 'Aim item result');
  const variant = string(result.variant, 'Aim result variant');
  const jobId = string(item.jobId, 'jobId');
  const metadata = record(exportJob.trustedMetadata, 'Aim trusted metadata');
  const source = record(exportJob.source, 'Aim source');
  const trustedMetadata = {
    company: string(metadata.company, 'company'),
    title: string(metadata.title, 'title'),
    location: metadata.location === null ? null : string(metadata.location, 'location'),
  };

  if (variant === 'safe_failure') {
    const code = string(result.code, 'Aim failure code') as AimSafeFailureCode;
    validateAimSafeFailureWorkerBindings(item, result);
    const keys = aimFailureKeys({
      jobId,
      inputHash: string(item.inputHash, 'inputHash'),
      extractionIdentity: string(exportJob.extractionIdentity, 'export extractionIdentity'),
      runnerProtocolHash: string(exportBatch.runnerProtocolHash, 'runnerProtocolHash'),
      scoringPolicyHash: string(exportBatch.scoringPolicyHash, 'scoringPolicyHash'),
      resultBuilderSemanticVersion: string(exportBatch.resultBuilderSemanticVersion, 'resultBuilderSemanticVersion'),
      code,
    });
    if (result.permanence !== keys.permanence || result.retrySeriesKey !== keys.retrySeriesKey
      || result.suppressionKey !== keys.suppressionKey) {
      throw new Error('Aim safe failure identity or permanence mismatch');
    }
    const detail = normalizeAimFailureDetail(string(result.detail, 'Aim failure detail'));
    if (detail !== result.detail) throw new Error('Aim failure detail is not canonical normalized text');
    if (item.extractionIdentity !== null || item.semanticResultHash !== null) {
      throw new Error('Aim safe failure cannot claim extraction or semantic-result identity');
    }
    return {
      jobId,
      ordinal: Number(item.ordinal),
      company: trustedMetadata.company,
      title: trustedMetadata.title,
      decision: 'safe_failure',
      variant,
      score: null,
      applicable: false,
      detail,
      assessment: result,
      failureRetrySeriesKey: keys.retrySeriesKey,
      failurePermanence: keys.permanence,
    };
  }

  const vector = recordOrNull(result.factualVector) as unknown as AimFactualVector | null;
  const controllerScope = variant === 'local_policy_kill' ? 'local_policy' : vector?.scope;
  if (!controllerScope) throw new Error('Aim terminal result is missing its controller scope');
  const builderInput: AimBuilderInput = {
    schemaVersion: 'aim-builder-input-v1',
    purpose: variant === 'scored_survivor' ? 'final' : 'checkpoint',
    controllerScope,
    canonicalSource: {
      originalJd: string(source.originalJd, 'originalJd'),
      sourceJdHash: string(source.sourceJdHash, 'sourceJdHash'),
    },
    trustedMetadata: {
      ...trustedMetadata,
      trustedMetadataHash: string(exportJob.trustedMetadataHash, 'trustedMetadataHash'),
    },
    factualVector: vector,
    holisticAssessment: variant === 'scored_survivor'
      ? {
          score: Number(result.score),
          rationale: string(result.rationale, 'Aim holistic rationale'),
        }
      : null,
    authorityBindings: {
      questionRegistryVersion: string(exportBatch.questionRegistryVersion, 'questionRegistryVersion'),
      questionRegistryHash: string(exportBatch.questionRegistryHash, 'questionRegistryHash'),
      scoringPolicyVersion: string(exportBatch.scoringPolicyVersion, 'scoringPolicyVersion'),
      scoringPolicyHash: string(exportBatch.scoringPolicyHash, 'scoringPolicyHash'),
      resultBuilderSemanticVersion: string(exportBatch.resultBuilderSemanticVersion, 'resultBuilderSemanticVersion'),
      runnerProtocolVersion: string(exportBatch.runnerProtocolVersion, 'runnerProtocolVersion'),
      runnerProtocolHash: string(exportBatch.runnerProtocolHash, 'runnerProtocolHash'),
      anonymizationPolicyVersion: string(exportBatch.anonymizationPolicyVersion, 'anonymizationPolicyVersion'),
      anonymizationPolicyHash: string(exportBatch.anonymizationPolicyHash, 'anonymizationPolicyHash'),
    },
    expectedExtractionIdentity: vector?.extractionIdentity ?? null,
  };
  const rebuilt = buildAimResultFromFactualVector(builderInput, { registry, policy });
  if (canonicalJson(rebuilt) !== canonicalJson(result)) throw new Error('Aim result differs from the application-owned deterministic rebuild');
  const terminal = rebuilt as AimTerminalResult;
  const extractionIdentity = vector?.extractionIdentity ?? null;
  if (item.extractionIdentity !== extractionIdentity) throw new Error('Aim item extraction identity mismatch');
  const expectedSemanticHash = aimSemanticResultHash({
    resultVariant: terminal.variant,
    extractionIdentity,
    scoringIdentity: terminal.scoringIdentity,
    deterministicResult: aimDeterministicResult(result),
  });
  if (item.semanticResultHash !== expectedSemanticHash) throw new Error('Aim semantic result hash mismatch');
  validateAimWorkerBindings(item, vector, recordOrNull(exportJob.reuse));
  const score = terminal.variant === 'scored_survivor' ? terminal.score : null;
  const band = terminal.variant === 'scored_survivor' ? terminal.band.label : null;
  return {
    jobId,
    ordinal: Number(item.ordinal),
    company: trustedMetadata.company,
    title: trustedMetadata.title,
    decision: terminal.decision,
    variant: terminal.variant,
    score,
    band,
    applicable: true,
    detail: terminal.variant === 'local_policy_kill'
      ? terminal.localTriggerCodes.join(', ')
      : terminal.variant === 'factual_screen_kill'
        ? terminal.triggerQuestionIds.join(', ')
        : terminal.variant === 'compensation_floor_kill'
          ? terminal.compensation.reasonCode
          : terminal.rationale,
    assessment: terminal,
  };
}

function verifyCandidateEvidenceBindings(outcome: JsonRecord, evidenceById: Map<string, JsonRecord>): void {
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
      startCodePoint: Number(binding.startCodePoint),
      endCodePoint: Number(binding.endCodePoint),
    }, string(binding.exactQuote, 'evidence exactQuote'));
    if ((support.includes(binding) && !['supports_complete', 'supports_partial'].includes(String(binding.relation)))
      || (conflict.includes(binding) && binding.relation !== 'conflicts')) {
      throw new Error('evidence relation is incompatible with its outcome field');
    }
  }
}

function assertJdSpan(source: string, value: unknown, field: string): JsonRecord {
  const span = record(value, field);
  assertExactCodePointQuote(source, {
    startCodePoint: Number(span.startCodePoint),
    endCodePoint: Number(span.endCodePoint),
  }, string(span.exactQuote, `${field}.exactQuote`));
  return span;
}

function historicalExperienceProjection(item: JsonRecord, exported: JsonRecord, exportJob: JsonRecord): ScoringImportProjection {
  const result = record(item.result, 'Experience item result');
  const metadata = record(exportJob.trustedMetadata, 'Experience trusted metadata');
  const company = string(metadata.company, 'company');
  const title = string(metadata.title, 'title');
  if (result.kind === 'safe_failure') {
    return {
      jobId: string(item.jobId, 'jobId'),
      ordinal: Number(item.ordinal),
      company,
      title,
      decision: 'safe_failure',
      variant: 'safe_failure',
      score: null,
      applicable: false,
      detail: string(result.detail, 'safe failure detail'),
      assessment: result,
    };
  }
  if (record(result.coverageAudit, 'coverage audit').complete !== true) throw new Error('Experience evaluation requires complete source coverage');
  const originalJd = string(exportJob.originalJd, 'Experience originalJd');
  const sourceJdHash = string(exportJob.sourceJdHash, 'Experience sourceJdHash');
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
    const criterionSource = assertJdSpan(originalJd, criterion.source, `criterion ${criterionId} source`);
    const expectedCriterionId = stableCriterionId(
      sourceJdHash,
      string(criterion.classification, 'classification') as 'required' | 'preferred',
      Number(criterionSource.startCodePoint),
      Number(criterionSource.endCodePoint),
    );
    if (criterionId !== expectedCriterionId) throw new Error(`Experience criterion identity mismatch for ${criterionId}`);
    const outcome = outcomesById.get(criterionId);
    if (!outcome) throw new Error(`missing outcome for ${criterionId}`);
    const sourceLeaves = array(criterion.leaves, 'criterion leaves').map((value) => record(value, 'criterion leaf'));
    const leafOutcomes = array(outcome.leaves, 'leaf outcomes').map((value) => record(value, 'leaf outcome'));
    if (sourceLeaves.length !== leafOutcomes.length) throw new Error(`leaf outcome coverage mismatch for ${criterionId}`);
    const leaves = sourceLeaves.map((leaf, index) => {
      assertJdSpan(originalJd, leaf.source, `criterion ${criterionId} leaf source`);
      const assessed = leafOutcomes[index];
      if (leaf.leafId !== assessed.leafId) throw new Error(`leaf order mismatch for ${criterionId}`);
      verifyCandidateEvidenceBindings(assessed, evidenceById);
      return {
        leafId: string(assessed.leafId, 'leafId'),
        outcome: string(assessed.outcome, 'leaf outcome') as ScoringCriterionOutcome,
      };
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
  if (result.decision !== recomputed.decision
    || integerOrNull(result.experienceFitScore, 'experienceFitScore') !== recomputed.experienceFitScore
    || integerOrNull(result.preferredPoints, 'preferredPoints') !== recomputed.preferredPoints) {
    throw new Error('Experience decision or score mismatch');
  }
  const blocking = array(result.blockingCriteria, 'blockingCriteria').map((value) => record(value, 'blocking criterion'));
  if (canonicalJsonSha256(blocking) !== canonicalJsonSha256(recomputed.blockingCriteria)) throw new Error('Experience blocking criteria mismatch');
  return {
    jobId: string(item.jobId, 'jobId'),
    ordinal: Number(item.ordinal),
    company,
    title,
    decision: recomputed.decision,
    variant: 'evaluation',
    score: recomputed.experienceFitScore,
    applicable: true,
    detail: recomputed.explanation,
    assessment: result,
  };
}

function experienceProjection(item: JsonRecord, exported: JsonRecord, exportJob: JsonRecord): ScoringImportProjection {
  if (exported.schemaVersion !== 'career-dashboard-experience-export-v2') {
    return historicalExperienceProjection(item, exported, exportJob);
  }
  const result = record(item.result, 'Experience item result');
  const metadata = record(exportJob.trustedMetadata, 'Experience trusted metadata');
  const company = string(metadata.company, 'company');
  const title = string(metadata.title, 'title');
  if (result.kind === 'safe_failure') {
    return {
      jobId: string(item.jobId, 'jobId'),
      ordinal: Number(item.ordinal),
      company,
      title,
      decision: 'safe_failure',
      variant: 'safe_failure',
      score: null,
      applicable: false,
      detail: string(result.detail, 'safe failure detail'),
      assessment: result,
    };
  }
  const decision = string(result.decision, 'Experience decision');
  const score = integerOrNull(result.experienceFitScore, 'experienceFitScore');
  if (score === null || score < 0 || score > 100) throw new Error('Experience score must be an integer from 0 to 100');
  const mismatches = array(result.hardRequirementsNotMet, 'hard requirements not met').map((value) => string(value, 'hard requirement'));
  const pass1RawOutput = string(result.pass1RawOutput, 'Experience pass 1 raw output');
  const pass2RawOutput = result.pass2RawOutput === null ? null : string(result.pass2RawOutput, 'Experience pass 2 raw output');
  if (decision === 'hard_requirement_mismatch') {
    if (score !== 0 || mismatches.length === 0 || pass2RawOutput !== null) {
      throw new Error('Experience hard-requirement mismatch result is internally inconsistent');
    }
  } else if (decision === 'scored') {
    if (mismatches.length !== 0 || pass2RawOutput === null) {
      throw new Error('Experience scored result is internally inconsistent');
    }
  } else {
    throw new Error(`unknown Experience decision ${decision}`);
  }
  const passed = experienceScorePasses(score);
  return {
    jobId: string(item.jobId, 'jobId'),
    ordinal: Number(item.ordinal),
    company,
    title,
    decision,
    variant: decision === 'hard_requirement_mismatch'
      ? 'hard_requirement_mismatch'
      : passed ? 'scored_survivor' : 'score_below_threshold',
    score,
    applicable: true,
    detail: string(result.rationale, 'Experience rationale'),
    assessment: { ...result, pass1RawOutput, pass2RawOutput },
  };
}

function expectedVersionsHash(batch: LoadedBatch): string {
  const versions = currentScoringInputVersions();
  return batch.stage === 'aim' ? versions.aimInputVersionsHash : versions.experienceInputVersionsHash;
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(message);
}

function validateStoredBatchExport(batch: LoadedBatch, exported: JsonRecord): void {
  if (createHash('sha256').update(batch.exportJson, 'utf8').digest('hex') !== batch.exportHash) {
    throw new Error('stored scoring export hash mismatch');
  }
  if (exported.schemaVersion !== batch.schemaVersion) throw new Error('stored export schema does not match its batch');
  const exportBatch = record(exported.batch, 'stored export batch');
  const versions = currentScoringInputVersions();
  const commonBindings: Array<[unknown, unknown, string]> = [
    [exportBatch.id, batch.id, 'id'],
    [exportBatch.stage, batch.stage, 'stage'],
    [exportBatch.protocolVersion, batch.protocolVersion, 'protocolVersion'],
    [exportBatch.exportSchemaVersion, batch.schemaVersion, 'exportSchemaVersion'],
    [exportBatch.manifestHash, batch.manifestHash, 'manifestHash'],
  ];
  if (batch.stage === 'aim') {
    commonBindings.push(
      [exportBatch.scoringPolicyVersion, batch.policyVersion, 'scoringPolicyVersion'],
      [exportBatch.questionRegistryHash, batch.questionRegistryHash, 'questionRegistryHash'],
      [exportBatch.promptContractHash, batch.promptContractHash, 'promptContractHash'],
      [exportBatch.responseContractHash, batch.responseContractHash, 'responseContractHash'],
      [exportBatch.runnerProtocolHash, batch.runnerProtocolHash, 'runnerProtocolHash'],
      [exportBatch.packetStrategyHash, batch.packetStrategyHash, 'packetStrategyHash'],
      [exportBatch.scoringPolicyHash, batch.scoringPolicyHash, 'scoringPolicyHash'],
      [exportBatch.anonymizationPolicyHash, batch.anonymizationPolicyHash, 'anonymizationPolicyHash'],
      [exportBatch.resultBuilderSemanticVersion, batch.resultBuilderSemanticVersion, 'resultBuilderSemanticVersion'],
    );
    const currentBindings: Array<[unknown, unknown, string]> = [
      [exportBatch.questionRegistryVersion, versions.questionRegistryVersion, 'current questionRegistryVersion'],
      [exportBatch.questionRegistryHash, versions.questionRegistryHash, 'current questionRegistryHash'],
      [exportBatch.scoringPolicyVersion, versions.aimPolicyVersion, 'current scoringPolicyVersion'],
      [exportBatch.scoringPolicyHash, versions.aimPolicyHash, 'current scoringPolicyHash'],
      [exportBatch.promptContractVersion, versions.promptContractVersion, 'current promptContractVersion'],
      [exportBatch.promptContractHash, versions.promptContractHash, 'current promptContractHash'],
      [exportBatch.responseContractVersion, versions.responseContractVersion, 'current responseContractVersion'],
      [exportBatch.responseContractHash, versions.responseContractHash, 'current responseContractHash'],
      [exportBatch.runnerProtocolVersion, versions.runnerProtocolVersion, 'current runnerProtocolVersion'],
      [exportBatch.runnerProtocolHash, versions.runnerProtocolHash, 'current runnerProtocolHash'],
      [exportBatch.packetStrategyVersion, versions.packetStrategyVersion, 'current packetStrategyVersion'],
      [exportBatch.packetStrategyHash, versions.packetStrategyHash, 'current packetStrategyHash'],
      [exportBatch.canonicalizationVersion, versions.canonicalizationVersion, 'current canonicalizationVersion'],
      [exportBatch.anonymizationPolicyVersion, versions.anonymizationPolicyVersion, 'current anonymizationPolicyVersion'],
      [exportBatch.anonymizationPolicyHash, versions.anonymizationPolicyHash, 'current anonymizationPolicyHash'],
      [exportBatch.extractorSemanticVersion, versions.extractorSemanticVersion, 'current extractorSemanticVersion'],
      [exportBatch.resultBuilderSemanticVersion, versions.resultBuilderSemanticVersion, 'current resultBuilderSemanticVersion'],
    ];
    commonBindings.push(...currentBindings);
  } else {
    commonBindings.push([exportBatch.policyVersion, batch.policyVersion, 'policyVersion']);
    const resume = record(exported.resume, 'stored Experience resume');
    const evidence = record(exported.evidence, 'stored Experience evidence');
    commonBindings.push(
      [resume.hash, batch.resumeHash, 'resumeHash'],
      [evidence.evidenceHash, batch.evidenceHash, 'evidenceHash'],
      [resume.hash, versions.resumeHash, 'current resumeHash'],
      [evidence.evidenceHash, versions.evidenceHash, 'current evidenceHash'],
    );
  }
  for (const [actual, expected, field] of commonBindings) {
    if (actual !== expected) throw new Error(`stored batch/export ${field} mismatch`);
  }

  const jobs = array(exported.jobs, 'stored export jobs').map((value) => record(value, 'stored export job'));
  if (jobs.length !== batch.items.length) throw new Error('stored batch/export membership mismatch');
  for (const [index, item] of batch.items.entries()) {
    const job = jobs[index];
    const snapshot = record(item.inputSnapshot, 'stored batch item snapshot');
    const sourceJdHash = batch.stage === 'aim'
      ? string(record(job.source, 'stored Aim source').sourceJdHash, 'sourceJdHash')
      : string(job.sourceJdHash, 'sourceJdHash');
    const basicBindings: Array<[unknown, unknown, string]> = [
      [item.ordinal, index, 'ordinal'],
      [item.stage, batch.stage, 'stage'],
      [job.ordinal, item.ordinal, 'job ordinal'],
      [job.jobId, item.jobId, 'jobId'],
      [job.inputHash, item.inputHash, 'inputHash'],
      [sourceJdHash, item.sourceJdHash, 'sourceJdHash'],
      [job.submittedUpdatedAt, item.submittedUpdatedAt.toISOString(), 'submittedUpdatedAt'],
      [snapshot.globalInputVersionsHash, batch.inputVersionsHash, 'globalInputVersionsHash'],
    ];
    for (const [actual, expected, field] of basicBindings) {
      if (actual !== expected) throw new Error(`stored batch item ${index} ${field} mismatch`);
    }
    for (const [field, value] of Object.entries(job)) {
      assertCanonicalEqual(snapshot[field], value, `stored batch item ${index} snapshot ${field} mismatch`);
    }
    if (batch.stage === 'aim') {
      const expectedInputHash = aimBatchItemInputHash({
        protocolVersion: batch.protocolVersion,
        exportSchemaVersion: batch.schemaVersion,
        sourceIdentity: string(job.sourceIdentity, 'Aim sourceIdentity'),
        extractionIdentity: string(job.extractionIdentity, 'Aim extractionIdentity'),
        scoringPolicyHash: string(batch.scoringPolicyHash, 'Aim scoringPolicyHash'),
        runnerProtocolHash: string(batch.runnerProtocolHash, 'Aim runnerProtocolHash'),
      });
      if (item.inputHash !== expectedInputHash) throw new Error(`stored Aim item ${index} input hash mismatch`);
      const reuse = recordOrNull(job.reuse);
      const reusedId = reuse ? string(reuse.aimFactualExtractionId, 'Aim reuse extraction ID') : null;
      if ((item.aimFactualExtractionId ?? null) !== reusedId) throw new Error(`stored Aim item ${index} reuse binding mismatch`);
    } else {
      const metadataHash = string(job.trustedMetadataHash, 'Experience trustedMetadataHash');
      const expectedInputHash = canonicalJsonSha256({
        kind: 'experience_batch_item_input_v2',
        stage: 'experience',
        protocolVersion: batch.protocolVersion,
        exportSchemaVersion: batch.schemaVersion,
        globalInputVersionsHash: batch.inputVersionsHash,
        sourceAimEventId: job.sourceAimEventId,
        aimFactualExtractionId: job.aimFactualExtractionId,
        sourceJdHash,
        trustedMetadataHash: metadataHash,
        aimSemanticResultHash: job.aimSemanticResultHash,
        resumeHash: batch.resumeHash,
        evidenceHash: batch.evidenceHash,
      });
      if (item.inputHash !== expectedInputHash) throw new Error(`stored Experience item ${index} input hash mismatch`);
      if (item.sourceAimEventId !== job.sourceAimEventId
        || item.aimFactualExtractionId !== job.aimFactualExtractionId
        || item.cleanedArtifactId !== null) {
        throw new Error(`stored Experience item ${index} parent binding mismatch`);
      }
    }
  }
}

export function buildScoringImportPreview(
  batch: LoadedBatch,
  payload: JsonRecord,
  options: { now?: Date } = {},
): ScoringImportPreview {
  if (!batch.schemaVersion.endsWith('-v2')) throw new Error('legacy_nonterminal_requires_release_and_v2_reexport');
  if (batch.inputVersionsHash !== expectedVersionsHash(batch)) throw new Error('scoring batch input versions are stale; release and re-export');
  const exported = parseScoringExchangeJson(batch.exportJson);
  validateStoredBatchExport(batch, exported);
  validateResultAgainstExport(payload, exported);
  const resultBatch = record(payload.batch, 'result batch');
  if (resultBatch.id !== batch.id || resultBatch.manifestHash !== batch.manifestHash) throw new Error('result does not bind the stored batch');
  if (batch.status === 'released' || batch.status === 'superseded') throw new Error(`batch status ${batch.status} is not importable`);
  if (batch.status === 'exported' && batch.expiresAt.valueOf() <= (options.now || new Date()).valueOf()) {
    throw new Error('expired batch requires explicit extension or release');
  }
  if (batch.items.some((item) => item.status !== 'leased')) throw new Error('nonterminal batch has non-leased items');
  if (payload.schemaVersion === 'career-dashboard-aim-result-v2' && payload.artifactPurpose !== 'production') {
    throw new Error('calibration Aim artifacts are not importable');
  }
  const exportJobs = array(exported.jobs, 'export jobs').map((value) => record(value, 'export job'));
  const resultItems = array(payload.results, 'results').map((value) => record(value, 'result item'));
  let projections: ScoringImportProjection[];
  if (batch.stage === 'aim') {
    const exportBatch = record(exported.batch, 'Aim export batch');
    const { registry } = loadAimQuestionRegistry(string(exportBatch.questionRegistryHash, 'questionRegistryHash'));
    const { policy } = loadAimScoringPolicy(registry, string(exportBatch.scoringPolicyHash, 'scoringPolicyHash'));
    projections = resultItems.map((item, index) => aimProjection({
      item,
      exportJob: exportJobs[index],
      exportBatch,
      registry,
      policy,
    }));
  } else {
    projections = resultItems.map((item, index) => experienceProjection(item, exported, exportJobs[index]));
  }
  const decisionCounts: Record<string, number> = {};
  for (const projection of projections) decisionCounts[projection.decision] = (decisionCounts[projection.decision] || 0) + 1;
  const outcomes = batch.stage === 'experience'
    ? resultItems.flatMap((item) => {
      const result = record(item.result, 'Experience item result');
      return result.kind === 'evaluation' && Array.isArray(result.outcomes)
        ? result.outcomes.map((value) => record(value, 'outcome'))
        : [];
    })
    : [];
  const scores = projections.flatMap((projection) => projection.score === null ? [] : [projection.score]);
  const acceptedCount = projections.filter((projection) => projection.applicable).length;
  return {
    version: 2,
    batchId: batch.id,
    stage: batch.stage as 'aim' | 'experience',
    resultHash: string(payload.resultHash, 'resultHash'),
    applicable: true,
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

function lifecycleProtected(job: { status: string; tailoringStaged: boolean }): boolean {
  return job.tailoringStaged || [
    'inbox', 'passed', 'dismissed', 'bookmarked', 'applied', 'interviewing', 'expired', 'archived', 'cooldown',
  ].includes(job.status);
}

function proposedStatus(stage: string, projection: ScoringImportProjection): string {
  if (stage === 'aim') return projection.variant === 'scored_survivor' ? 'pending_af' : 'dismissed';
  return projection.score !== null && experienceScorePasses(projection.score) ? 'inbox' : 'dismissed';
}

async function bindDatabasePreview(
  client: ImportDbClient,
  preview: ScoringImportPreview,
  batch: LoadedBatch,
): Promise<ScoringImportPreview> {
  const exported = parseScoringExchangeJson(batch.exportJson);
  const exportJobs = array(exported.jobs, 'stored export jobs').map((value) => record(value, 'stored export job'));
  const jobs = await client.job.findMany({
    where: { id: { in: batch.items.map((item) => item.jobId) } },
    select: {
      id: true,
      updatedAt: true,
      status: true,
      tailoringStaged: true,
      company: true,
      title: true,
      location: true,
      description: true,
    },
  });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const submittedByJob = new Map(batch.items.map((item) => [item.jobId, item.submittedUpdatedAt.valueOf()]));
  const retryKeys = preview.projections.flatMap((projection) => projection.failureRetrySeriesKey ? [projection.failureRetrySeriesKey] : []);
  const priorFailures = retryKeys.length === 0 ? [] : await client.aimScoringFailureReceipt.groupBy({
    by: ['retrySeriesKey'],
    where: { retrySeriesKey: { in: retryKeys } },
    _max: { seriesOrdinal: true },
  });
  const priorByKey = new Map(priorFailures.map((entry) => [entry.retrySeriesKey, entry._max.seriesOrdinal ?? 0]));
  if (batch.stage === 'experience') {
    const versions = currentScoringInputVersions();
    const sourceIds = batch.items.map((item) => item.sourceAimEventId).filter((value): value is string => Boolean(value));
    const extractionIds = batch.items.map((item) => item.aimFactualExtractionId).filter((value): value is string => Boolean(value));
    const [sourceEvents, extractions, newestAimEvents] = await Promise.all([
      client.jobScoreEvent.findMany({ where: { id: { in: sourceIds } } }),
      client.aimFactualExtraction.findMany({ where: { id: { in: extractionIds } } }),
      client.jobScoreEvent.findMany({
        where: { jobId: { in: batch.items.map((item) => item.jobId) }, evaluationType: 'aim_fit' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const eventById = new Map(sourceEvents.map((event) => [event.id, event]));
    const extractionById = new Map(extractions.map((extraction) => [extraction.id, extraction]));
    const newestByJob = new Map<string, typeof newestAimEvents[number]>();
    for (const event of newestAimEvents) if (!newestByJob.has(event.jobId)) newestByJob.set(event.jobId, event);
    for (const [index, item] of batch.items.entries()) {
      const sourceEvent = item.sourceAimEventId ? eventById.get(item.sourceAimEventId) : null;
      const extraction = item.aimFactualExtractionId ? extractionById.get(item.aimFactualExtractionId) : null;
      const exportJob = exportJobs[index];
      const inputBindings = sourceEvent ? record(sourceEvent.inputBindings, 'source Aim input bindings') : null;
      if (!sourceEvent || newestByJob.get(item.jobId)?.id !== sourceEvent.id
        || sourceEvent.jobId !== item.jobId
        || sourceEvent.evaluationType !== 'aim_fit'
        || sourceEvent.schemaVersion !== 'career-dashboard-aim-result-v2'
        || sourceEvent.staleAt !== null
        || sourceEvent.passed !== true
        || sourceEvent.aimFactualExtractionId !== item.aimFactualExtractionId
        || sourceEvent.semanticResultHash !== exportJob.aimSemanticResultHash
        || inputBindings?.globalInputVersionsHash !== versions.aimInputVersionsHash) {
        throw new Error(`Experience item ${index} no longer binds the current Aim authority`);
      }
      if (!extraction || extraction.jobId !== item.jobId
        || !isCurrentAimExperienceAnchor(extraction, item.sourceJdHash)) {
        throw new Error(`Experience item ${index} no longer binds the current Stage 1 Aim extraction`);
      }
    }
  }
  const projections = preview.projections.map((projection, index) => {
    const job = jobsById.get(projection.jobId);
    if (!job) throw new Error(`job ${projection.jobId} no longer exists`);
    if (job.updatedAt.valueOf() !== submittedByJob.get(job.id)) throw new Error(`job ${job.id} changed after export`);
    const exportJob = exportJobs[index];
    const originalJd = normalizeScoringText(job.description || '');
    const trustedMetadata = normalizeAimTrustedMetadata({
      company: job.company,
      title: job.title,
      location: job.location,
    });
    if (batch.stage === 'aim') {
      assertCanonicalEqual(record(exportJob.source, 'Aim export source').originalJd, originalJd, `job ${job.id} source changed after export`);
    } else {
      assertCanonicalEqual(exportJob.originalJd, originalJd, `job ${job.id} source changed after export`);
    }
    assertCanonicalEqual(exportJob.trustedMetadata, trustedMetadata, `job ${job.id} trusted metadata changed after export`);
    if (exportJob.trustedMetadataHash !== aimTrustedMetadataHash(trustedMetadata)
      || (batch.stage === 'aim' ? record(exportJob.source, 'Aim export source').sourceJdHash : exportJob.sourceJdHash) !== aimSourceJdHash(originalJd)) {
      throw new Error(`job ${job.id} source identity changed after export`);
    }
    const protectedLifecycle = lifecycleProtected(job);
    if (!projection.applicable) {
      const seriesOrdinal = projection.failureRetrySeriesKey
        ? (priorByKey.get(projection.failureRetrySeriesKey) ?? 0) + 1
        : undefined;
      return {
        ...projection,
        company: projection.company || job.company,
        title: projection.title || job.title,
        proposedStatus: job.status,
        currentStatus: job.status,
        lifecycleAction: 'action_needed' as const,
        failureSeriesOrdinal: seriesOrdinal,
        suppressionActiveAfterApply: batch.stage === 'aim' ? true : seriesOrdinal === undefined ? undefined
          : projection.failurePermanence === 'input_bound' || seriesOrdinal >= 3,
      };
    }
    return {
      ...projection,
      company: projection.company || job.company,
      title: projection.title || job.title,
      proposedStatus: proposedStatus(batch.stage, projection),
      currentStatus: job.status,
      lifecycleAction: protectedLifecycle ? 'preserve_protected' as const : 'apply' as const,
    };
  });
  return {
    ...preview,
    protectedLifecycleCount: projections.filter((projection) => (
      projection.applicable && projection.lifecycleAction === 'preserve_protected'
    )).length,
    projections,
  };
}

function completedReplayPreview(batch: LoadedBatch, payload: JsonRecord): ScoringImportPreview {
  const resultItems = array(payload.results, 'results');
  const imported = batch.items.filter((item) => item.status === 'imported').length;
  const released = batch.items.filter((item) => item.status === 'released').length;
  return {
    version: 2,
    batchId: batch.id,
    stage: batch.stage as 'aim' | 'experience',
    resultHash: string(payload.resultHash, 'resultHash'),
    applicable: true,
    itemCount: resultItems.length,
    expectedCount: batch.items.length,
    suppliedCount: resultItems.length,
    acceptedCount: imported,
    rejectedCount: released,
    safeFailureCount: released,
    cannotEvaluateCount: 0,
    doesNotMeetCount: 0,
    protectedLifecycleCount: 0,
    scoreRange: null,
    decisionCounts: { idempotent_replay: resultItems.length },
    projections: [],
  };
}

export async function previewScoringImport(
  prisma: PrismaClient,
  rawPayload: string | Buffer,
  options: { approvalSecret?: string; now?: Date } = {},
) {
  const payload = parseScoringExchangeJson(rawPayload);
  const resultBatch = record(payload.batch, 'result batch');
  const batch = await prisma.scoringBatch.findUnique({
    where: { id: string(resultBatch.id, 'batch ID') },
    include: { items: { orderBy: { ordinal: 'asc' } } },
  });
  if (!batch) throw new Error('scoring batch not found');
  if (batch.status === 'completed') {
    const exported = parseScoringExchangeJson(batch.exportJson);
    validateResultAgainstExport(payload, exported);
    if (batch.acceptedResultHash !== payload.resultHash) throw new Error('completed batch rejects divergent replay');
    const preview = completedReplayPreview(batch, payload);
    return {
      preview,
      approvalToken: null,
      approvalExpiresAt: null,
      receipt: {
        batchId: batch.id,
        resultHash: preview.resultHash,
        idempotentReplay: true,
        imported: preview.acceptedCount,
        released: preview.safeFailureCount,
      },
    };
  }
  let preview = buildScoringImportPreview(batch, payload, { now: options.now });
  preview = await bindDatabasePreview(prisma, preview, batch);
  const approval = createScoringApprovalToken(
    { batchId: batch.id, resultHash: preview.resultHash, preview },
    { secret: options.approvalSecret, now: options.now },
  );
  return { preview, approvalToken: approval.token, approvalExpiresAt: approval.claims.expiresAt };
}

function scopeRank(scope: string): number {
  return ({ stage1: 1, compensation_preflight: 2, complete: 3 } as Record<string, number>)[scope] ?? 0;
}

function assertLaterScopePreservesEarlier(later: AimFactualVector, earlier: AimFactualVector): void {
  if (scopeRank(later.scope) <= scopeRank(earlier.scope)) return;
  const laterAnswers = new Map(later.answers.map((answer) => [answer.questionId, answer]));
  const laterEvidence = new Map(later.evidenceCatalog.map((entry) => [entry.evidenceId, entry]));
  for (const answer of earlier.answers) {
    const candidate = laterAnswers.get(answer.questionId);
    if (!candidate || canonicalJson(candidate) !== canonicalJson(answer)) {
      throw new Error('later Aim extraction scope changes an accepted earlier answer');
    }
    for (const evidenceId of answer.evidenceIds) {
      const prior = earlier.evidenceCatalog.find((entry) => entry.evidenceId === evidenceId);
      const next = laterEvidence.get(evidenceId);
      if (!prior || !next || canonicalJson(prior) !== canonicalJson(next)) {
        throw new Error('later Aim extraction scope changes accepted earlier evidence');
      }
    }
  }
}

async function persistAimExtraction(
  tx: Prisma.TransactionClient,
  item: ScoringBatchItem,
  resultItem: JsonRecord,
  result: JsonRecord,
  controller: JsonRecord,
): Promise<string | null> {
  const vector = recordOrNull(result.factualVector) as unknown as AimFactualVector | null;
  if (!vector) return null;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM "AimFactualExtraction"
    WHERE "jobId" = ${item.jobId} AND "extractionIdentity" = ${vector.extractionIdentity}
    FOR UPDATE
  `);
  const existing = await tx.aimFactualExtraction.findUnique({
    where: { jobId_extractionIdentity_scope: { jobId: item.jobId, extractionIdentity: vector.extractionIdentity, scope: vector.scope } },
  });
  if (existing) {
    if (existing.staleAt || existing.factualVectorHash !== vector.factualVectorHash
      || canonicalJson(existing.extractionSnapshot) !== canonicalJson(vector)) {
      throw new Error('extraction_identity_vector_conflict');
    }
    return existing.id;
  }
  const earlier = await tx.aimFactualExtraction.findMany({
    where: { jobId: item.jobId, extractionIdentity: vector.extractionIdentity, staleAt: null },
  });
  for (const row of earlier) assertLaterScopePreservesEarlier(vector, row.extractionSnapshot as unknown as AimFactualVector);
  const id = randomUUID();
  await tx.aimFactualExtraction.create({
    data: {
      id,
      jobId: item.jobId,
      schemaVersion: vector.schemaVersion,
      scope: vector.scope,
      extractionIdentity: vector.extractionIdentity,
      factualVectorHash: vector.factualVectorHash,
      sourceJdHash: vector.sourceJdHash,
      trustedMetadataHash: vector.trustedMetadataHash,
      questionRegistryVersion: vector.questionRegistryVersion,
      questionRegistryHash: vector.questionRegistryHash,
      promptContractVersion: vector.promptContractVersion,
      promptContractHash: vector.promptContractHash,
      responseContractVersion: vector.responseContractVersion,
      responseContractHash: vector.responseContractHash,
      runnerProtocolVersion: vector.runnerProtocolVersion,
      runnerProtocolHash: vector.runnerProtocolHash,
      packetStrategyVersion: vector.packetStrategyVersion,
      packetStrategyHash: vector.packetStrategyHash,
      canonicalizationVersion: vector.canonicalizationVersion,
      anonymizationPolicyVersion: vector.anonymizationPolicyVersion,
      anonymizationPolicyHash: vector.anonymizationPolicyHash,
      extractorSemanticVersion: vector.extractorSemanticVersion,
      latestPacketPlanHash: vector.provenance.packetPlanHash,
      extractionSnapshot: vector as unknown as Prisma.InputJsonValue,
      workerProvenance: {
        controller,
        workers: array(resultItem.workers, 'Aim workers'),
        packets: vector.provenance.packets,
      } as unknown as Prisma.InputJsonValue,
      producedByBatchItemId: item.id,
    },
  });
  return id;
}

function aimModelProvenance(result: JsonRecord, resultItem: JsonRecord): { model: string; promptVersion: string } {
  if (result.variant === 'local_policy_kill') return { model: 'deterministic-local-policy', promptVersion: 'no-model-local-policy-v1' };
  if (array(resultItem.workers, 'Aim workers').length === 0) {
    return { model: 'deterministic-rescore', promptVersion: 'aim-factual-vector-reuse-v1' };
  }
  const vector = record(result.factualVector, 'Aim factual vector') as unknown as AimFactualVector;
  const models = [...new Set(vector.provenance.packets.map((packet: AimPacketReceipt) => packet.model))];
  if (models.length !== 1) throw new Error('Aim extraction has ambiguous accepted model provenance');
  return {
    model: models[0],
    promptVersion: result.variant === 'scored_survivor'
      ? 'aim-stage2-holistic-v1'
      : 'aim-factual-questions-v1',
  };
}

async function clearManualRetryReceipt(
  tx: Prisma.TransactionClient,
  item: ScoringBatchItem,
  now: Date,
): Promise<void> {
  if (!item.manualRetryOfFailureReceiptId) return;
  const cleared = await tx.aimScoringFailureReceipt.updateMany({
    where: { id: item.manualRetryOfFailureReceiptId, suppressionActive: true, clearedAt: null },
    data: {
      suppressionActive: false,
      clearedAt: now,
      clearedReason: 'manual_retry_resolved',
      clearedActor: 'operator',
    },
  });
  if (cleared.count !== 1) throw new Error('manual Aim retry suppression is no longer active');
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

  const applyOnce = () => prisma.$transaction(async (tx) => {
    const [lockedBatch] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ScoringBatch" WHERE id = ${batchId} FOR UPDATE
    `;
    if (!lockedBatch) throw new Error('scoring batch not found');
    const batch = await tx.scoringBatch.findUnique({
      where: { id: batchId },
      include: { items: { orderBy: { ordinal: 'asc' } } },
    });
    if (!batch) throw new Error('scoring batch not found');
    const exported = parseScoringExchangeJson(batch.exportJson);
    validateResultAgainstExport(payload, exported);
    if (batch.status === 'completed') {
      if (batch.acceptedResultHash !== resultHash) throw new Error('completed batch rejects divergent replay');
      return {
        batchId,
        resultHash,
        idempotentReplay: true,
        imported: batch.items.filter((item) => item.status === 'imported').length,
        released: batch.items.filter((item) => item.status === 'released').length,
      };
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "ScoringBatchItem" WHERE "batchId" = ${batchId} ORDER BY ordinal FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "Job" WHERE id IN (${Prisma.join(batch.items.map((item) => item.jobId))}) ORDER BY id FOR UPDATE
    `);
    const extractionIds = batch.items.flatMap((item) => item.aimFactualExtractionId ? [item.aimFactualExtractionId] : []);
    if (extractionIds.length > 0) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "AimFactualExtraction" WHERE id IN (${Prisma.join(extractionIds)}) ORDER BY id FOR UPDATE
      `);
    }
    const sourceAimEventIds = batch.items.flatMap((item) => item.sourceAimEventId ? [item.sourceAimEventId] : []);
    if (sourceAimEventIds.length > 0) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "JobScoreEvent" WHERE id IN (${Prisma.join(sourceAimEventIds)}) ORDER BY id FOR UPDATE
      `);
    }
    const manualRetryReceiptIds = batch.items.flatMap((item) => (
      item.manualRetryOfFailureReceiptId ? [item.manualRetryOfFailureReceiptId] : []
    ));
    if (manualRetryReceiptIds.length > 0) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "AimScoringFailureReceipt"
        WHERE id IN (${Prisma.join(manualRetryReceiptIds)})
        ORDER BY id FOR UPDATE
      `);
    }
    let preview = buildScoringImportPreview(batch, payload, { now });
    preview = await bindDatabasePreview(tx, preview, batch);
    verifyScoringApprovalToken(approvalToken, { batchId, resultHash, preview }, { now, secret: options.approvalSecret });

    const resultItems = array(payload.results, 'results').map((value) => record(value, 'result item'));
    const controller = batch.stage === 'aim' ? record(payload.controller, 'Aim controller') : record(payload.runner, 'Experience runner');
    const aimExportBatch = batch.stage === 'aim' ? record(exported.batch, 'Aim export batch') : null;

    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index];
      const resultItem = resultItems[index];
      const result = record(resultItem.result, 'result');
      const projection = preview.projections[index];
      const job = await tx.job.findUniqueOrThrow({
        where: { id: item.jobId },
        select: { status: true, tailoringStaged: true, source: true, sourceId: true },
      });
      const protectedLifecycle = lifecycleProtected(job);
      await clearManualRetryReceipt(tx, item, now);

      if (!projection.applicable) {
        if (batch.stage === 'aim') {
          const sourceSnapshot = record(item.inputSnapshot, 'Aim input snapshot');
          await recordAimFailureReceipt({
            tx,
            jobId: item.jobId,
            producedByBatchItemId: item.id,
            sourceIdentity: string(sourceSnapshot.sourceIdentity, 'sourceIdentity'),
            extractionIdentity: string(sourceSnapshot.extractionIdentity, 'extractionIdentity'),
            inputHash: item.inputHash,
            protocolVersion: batch.protocolVersion,
            runnerProtocolHash: string(aimExportBatch!.runnerProtocolHash, 'runnerProtocolHash'),
            scoringPolicyHash: string(aimExportBatch!.scoringPolicyHash, 'scoringPolicyHash'),
            resultBuilderSemanticVersion: string(aimExportBatch!.resultBuilderSemanticVersion, 'resultBuilderSemanticVersion'),
            code: string(result.code, 'failure code') as AimSafeFailureCode,
            phase: string(result.phase, 'failure phase') as Parameters<typeof recordAimFailureReceipt>[0]['phase'],
            packetOrdinal: integerOrNull(result.packetOrdinal, 'failure packetOrdinal'),
            attempts: Number(result.attempts),
            detail: string(result.detail, 'failure detail'),
            activateSuppression: true,
          });
        }
        await tx.scoringBatchItem.update({
          where: { id: item.id },
          data: {
            status: 'released',
            releasedAt: now,
            acceptedResultHash: string(resultItem.resultHash, 'item resultHash'),
            acceptedResultSnapshot: resultItem as Prisma.InputJsonValue,
          },
        });
        await tx.job.update({
          where: { id: item.jobId },
          data: actionNeededUpdateForScoringFailure(batch.stage as 'aim' | 'experience', projection.detail),
        });
        if (options.injectFailureAfterItems === index + 1) throw new Error('injected scoring import failure');
        continue;
      }

      const aimExtractionId = batch.stage === 'aim'
        ? await persistAimExtraction(tx, item, resultItem, result, controller)
        : item.aimFactualExtractionId;
      const eventId = randomUUID();
      const proposed = proposedStatus(batch.stage, projection);
      const lifecycleApplied = !protectedLifecycle;
      const provenance = batch.stage === 'aim'
        ? aimModelProvenance(result, resultItem)
        : { model: string(controller.model, 'runner model'), promptVersion: string(controller.promptVersion, 'runner prompt version') };
      const decisionCode = projection.decision;
      const scoringIdentity = batch.stage === 'aim' ? string(result.scoringIdentity, 'Aim scoringIdentity') : null;
      const idempotencyKey = batch.stage === 'aim'
        ? canonicalJsonSha256({ kind: 'aim_score_event_idempotency_v2', jobId: item.jobId, scoringIdentity, decisionCode })
        : canonicalJsonSha256({ kind: 'experience_score_event_idempotency_v2', jobId: item.jobId, inputHash: item.inputHash, decisionCode });
      await tx.jobScoreEvent.create({
        data: {
          id: eventId,
          jobId: item.jobId,
          evaluationType: batch.stage === 'aim' ? 'aim_fit' : 'experience_fit',
          model: provenance.model,
          promptVersion: provenance.promptVersion,
          policyVersion: batch.policyVersion,
          idempotencyKey,
          schemaVersion: string(payload.schemaVersion, 'result schemaVersion'),
          batchId: batch.id,
          batchItemId: item.id,
          manifestHash: batch.manifestHash,
          inputHash: item.inputHash,
          resultHash: string(resultItem.resultHash, 'item resultHash'),
          semanticResultHash: batch.stage === 'aim' ? string(resultItem.semanticResultHash, 'semanticResultHash') : null,
          evidenceHash: batch.evidenceHash,
          sourceAimEventId: item.sourceAimEventId,
          aimFactualExtractionId: aimExtractionId,
          cleanedJdArtifactId: null,
          decisionCode,
          questionRegistryHash: batch.questionRegistryHash,
          scoringPolicyHash: batch.scoringPolicyHash,
          resultBuilderSemanticVersion: batch.resultBuilderSemanticVersion,
          scoringIdentity,
          aimAssessments: batch.stage === 'aim' ? result as Prisma.InputJsonValue : Prisma.JsonNull,
          mandatoryRequirementAssessments: batch.stage === 'experience' ? result as Prisma.InputJsonValue : Prisma.JsonNull,
          travelAssessment: Prisma.JsonNull,
          compensationAssessment: batch.stage === 'aim' && result.compensation
            ? result.compensation as Prisma.InputJsonValue : Prisma.JsonNull,
          inputBindings: item.inputSnapshot as Prisma.InputJsonValue,
          workerProvenance: { controller, workers: array(resultItem.workers, 'worker provenance') } as unknown as Prisma.InputJsonValue,
          lifecycleProjection: proposed,
          lifecyclePriorStatus: job.status,
          lifecycleApplied,
          aimFitScore: batch.stage === 'aim' ? projection.score : null,
          experienceFitScore: batch.stage === 'experience' ? projection.score : null,
          travelScore: null,
          passed: batch.stage === 'aim'
            ? projection.variant === 'scored_survivor'
            : projection.score !== null && experienceScorePasses(projection.score),
          aimReason: batch.stage === 'aim' ? projection.detail : null,
          experienceReason: batch.stage === 'experience' ? projection.detail : null,
        },
      });
      await tx.scoringBatchItem.update({
        where: { id: item.id },
        data: {
          status: 'imported',
          importedAt: now,
          acceptedResultHash: string(resultItem.resultHash, 'item resultHash'),
          acceptedResultSnapshot: resultItem as Prisma.InputJsonValue,
          importedScoreEventId: eventId,
          aimFactualExtractionId: aimExtractionId,
          latestPacketPlanHash: batch.stage === 'aim'
            ? (resultItem.packetPlanHash === null ? null : string(resultItem.packetPlanHash, 'packetPlanHash'))
            : item.latestPacketPlanHash,
        },
      });
      const jobScoreData = batch.stage === 'aim'
        ? {
          aimFitScore: projection.variant === 'scored_survivor' ? projection.score : null,
          travelScore: null,
        }
        : { reqFitScore: projection.score };
      await tx.job.update({
        where: { id: item.jobId },
        data: { ...jobScoreData, ...(lifecycleApplied ? { status: proposed } : {}) },
      });
      if (batch.stage === 'experience') {
        const experiencePassed = projection.score !== null && experienceScorePasses(projection.score);
        await recordJobPipelineEvent({
          eventType: experiencePassed ? 'ae_pass' : 'ae_reject',
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
            enteredInbox: experiencePassed && lifecycleApplied,
            actor: 'machine',
            protected: protectedLifecycle,
          },
        }, tx);
      }
      if (options.injectFailureAfterItems === index + 1) throw new Error('injected scoring import failure');
    }
    const activeLeases = await tx.scoringBatchItem.count({ where: { batchId: batch.id, status: 'leased' } });
    if (activeLeases !== 0) throw new Error('scoring batch still has active leases after apply');
    await tx.scoringBatch.update({
      where: { id: batch.id },
      data: { status: 'completed', completedAt: now, acceptedResultHash: resultHash },
    });
    return {
      batchId,
      resultHash,
      idempotentReplay: false,
      imported: preview.acceptedCount,
      released: preview.safeFailureCount,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  let applied: Awaited<ReturnType<typeof applyOnce>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      applied = await applyOnce();
      break;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code !== 'P2034' || attempt === 3) throw error;
    }
  }
  if (!applied) throw new Error('serializable scoring import did not produce a receipt');

  return applied;
}
