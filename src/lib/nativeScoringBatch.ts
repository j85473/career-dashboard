import { createHash } from 'node:crypto';

import { negativeOnlyContextRules } from './contextFeedbackPolicy';

export const NATIVE_SCORING_SCHEMA_VERSION = 'native-scoring-batch-v6.2';
export const NATIVE_SCORING_CHUNK_SIZE = 5;
export const CONTEXT_PROMPT_VERSION = 'context-job-evaluator-v6.2';
export const STANDARD_PROMPT_VERSION = 'standard-job-evaluator-v6.2';
export const WILDCARD_PROMPT_VERSION = 'wildcard-job-evaluator-v6.2';
export const MANAGER_PROMPT_VERSION = 'scoring-manager-v6.2';

type JsonRecord = Record<string, unknown>;

export type NativeScoringType = 'context' | 'standard' | 'wildcard';

export interface NativeContextProfile {
  rulesText: string;
  submittedUpdatedAt: string | null;
}

export interface ManifestJob {
  id: string;
  submittedUpdatedAt: string;
}

export interface ManifestChunk {
  chunkId: string;
  type: NativeScoringType;
  inputFile: string;
  resultFile: string;
  inputHash: string;
  jobs: ManifestJob[];
}

export interface ManifestPrompt {
  version: string;
  file: string;
  sha256: string;
}

export interface NativeScoringManifest {
  schemaVersion: typeof NATIVE_SCORING_SCHEMA_VERSION;
  batchId: string;
  createdAt: string;
  chunkSize: typeof NATIVE_SCORING_CHUNK_SIZE;
  model: {
    surface: 'antigravity-native-subagent';
    tier: 'flash';
    expectedModel: 'gemini-3.6-flash';
  };
  prompts: {
    context: ManifestPrompt;
    standard: ManifestPrompt;
    wildcard: ManifestPrompt;
    manager: ManifestPrompt;
  };
  evidence: {
    file: string;
    sha256: string;
  };
  contextSnapshot: {
    file: string;
    sha256: string;
    submittedUpdatedAt: string | null;
  };
  exportSnapshot: {
    file: string;
    sha256: string;
  };
  chunks: ManifestChunk[];
  manifestHash: string;
}

export interface NativeScoringJob {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  submittedUpdatedAt: string;
}

export interface NativeContextFeedbackJob extends NativeScoringJob {
  passReason: string;
}

interface NativeScoringChunkBase {
  schemaVersion: typeof NATIVE_SCORING_SCHEMA_VERSION;
  batchId: string;
  chunkId: string;
}

export interface NativeContextScoringChunk extends NativeScoringChunkBase {
  type: 'context';
  contextProfile: NativeContextProfile;
  jobs: NativeContextFeedbackJob[];
}

export interface NativeStandardScoringChunk extends NativeScoringChunkBase {
  type: 'standard';
  contextProfile: NativeContextProfile;
  jobs: NativeScoringJob[];
}

export interface NativeWildcardScoringChunk extends NativeScoringChunkBase {
  type: 'wildcard';
  jobs: NativeScoringJob[];
}

export type NativeScoringChunk =
  | NativeContextScoringChunk
  | NativeStandardScoringChunk
  | NativeWildcardScoringChunk;

export interface StandardScore {
  id: string;
  aimFitScore: number;
  experienceFitScore: number;
  aimFitReason: string;
  experienceFitReason: string;
  travelScore: number;
  evidenceIds: string[];
}

export interface WildcardScore {
  id: string;
  vibeFitScore: number;
  vibeFitReason: string;
}

export interface ContextUpdateResult {
  submittedContextProfileUpdatedAt: string | null;
  updatedContextRules: string;
  processedFeedback: ManifestJob[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_ID_PATTERN = /^chunk_\d{4}$/;
const SAFE_BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const EVIDENCE_ID_PATTERN = /^[A-Z][A-Z0-9]*-\d{3}$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertExactKeys(record: JsonRecord, keys: readonly string[], field: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${field} must contain exactly these keys: ${expected.join(', ')}`);
  }
}

function requiredString(
  record: JsonRecord,
  key: string,
  field: string,
  maxLength = 10_000,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
    throw new Error(`${field}.${key} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field}.${key} exceeds ${maxLength} characters`);
  }
  return value;
}

function requiredIsoTimestamp(record: JsonRecord, key: string, field: string): string {
  const value = requiredString(record, key, field, 64);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${field}.${key} must be a canonical ISO timestamp`);
  }
  return value;
}

function requiredScore(record: JsonRecord, key: string, field: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error(`${field}.${key} must be an integer from 0 through 100`);
  }
  return value as number;
}

function requiredSha256(record: JsonRecord, key: string, field: string): string {
  const value = requiredString(record, key, field, 64);
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${field}.${key} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertSafeRelativePath(value: string, field: string): void {
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || value.split(/[\\/]/).includes('..')
    || value.includes('\u0000')
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function parsePrompt(value: unknown, field: string): ManifestPrompt {
  const record = assertRecord(value, field);
  assertExactKeys(record, ['version', 'file', 'sha256'], field);
  const file = requiredString(record, 'file', field, 500);
  assertSafeRelativePath(file, `${field}.file`);
  return {
    version: requiredString(record, 'version', field, 100),
    file,
    sha256: requiredSha256(record, 'sha256', field),
  };
}

function parseManifestJob(value: unknown, field: string): ManifestJob {
  const record = assertRecord(value, field);
  assertExactKeys(record, ['id', 'submittedUpdatedAt'], field);
  const id = requiredString(record, 'id', field, 100);
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`${field}.id must be a UUID`);
  }
  return {
    id,
    submittedUpdatedAt: requiredIsoTimestamp(record, 'submittedUpdatedAt', field),
  };
}

function parseManifestChunk(value: unknown, field: string): ManifestChunk {
  const record = assertRecord(value, field);
  assertExactKeys(
    record,
    ['chunkId', 'type', 'inputFile', 'resultFile', 'inputHash', 'jobs'],
    field,
  );
  const chunkId = requiredString(record, 'chunkId', field, 40);
  if (!CHUNK_ID_PATTERN.test(chunkId)) {
    throw new Error(`${field}.chunkId must match chunk_0000`);
  }
  if (record.type !== 'context' && record.type !== 'standard' && record.type !== 'wildcard') {
    throw new Error(`${field}.type must be context, standard, or wildcard`);
  }
  const inputFile = requiredString(record, 'inputFile', field, 500);
  const resultFile = requiredString(record, 'resultFile', field, 500);
  assertSafeRelativePath(inputFile, `${field}.inputFile`);
  assertSafeRelativePath(resultFile, `${field}.resultFile`);
  if (inputFile !== `chunks/${chunkId}.json`) {
    throw new Error(`${field}.inputFile does not match its chunkId`);
  }
  if (resultFile !== `results/${chunkId}.result.json`) {
    throw new Error(`${field}.resultFile does not match its chunkId`);
  }
  if (!Array.isArray(record.jobs) || record.jobs.length < 1 || record.jobs.length > NATIVE_SCORING_CHUNK_SIZE) {
    throw new Error(`${field}.jobs must contain 1 through ${NATIVE_SCORING_CHUNK_SIZE} jobs`);
  }
  const jobs = record.jobs.map((job, index) => parseManifestJob(job, `${field}.jobs[${index}]`));
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error(`${field}.jobs contains duplicate IDs`);
  }
  return {
    chunkId,
    type: record.type,
    inputFile,
    resultFile,
    inputHash: requiredSha256(record, 'inputHash', field),
    jobs,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function manifestHash(
  manifest: Omit<NativeScoringManifest, 'manifestHash'>,
): string {
  return sha256(canonicalJson(manifest));
}

export function parseNativeScoringManifest(value: unknown): NativeScoringManifest {
  const record = assertRecord(value, 'manifest');
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'batchId',
      'createdAt',
      'chunkSize',
      'model',
      'prompts',
      'evidence',
      'contextSnapshot',
      'exportSnapshot',
      'chunks',
      'manifestHash',
    ],
    'manifest',
  );
  if (record.schemaVersion !== NATIVE_SCORING_SCHEMA_VERSION) {
    throw new Error(`manifest.schemaVersion must be ${NATIVE_SCORING_SCHEMA_VERSION}`);
  }
  const batchId = requiredString(record, 'batchId', 'manifest', 160);
  if (!SAFE_BATCH_ID_PATTERN.test(batchId)) {
    throw new Error('manifest.batchId contains unsafe characters');
  }
  if (record.chunkSize !== NATIVE_SCORING_CHUNK_SIZE) {
    throw new Error(`manifest.chunkSize must be ${NATIVE_SCORING_CHUNK_SIZE}`);
  }

  const model = assertRecord(record.model, 'manifest.model');
  assertExactKeys(model, ['surface', 'tier', 'expectedModel'], 'manifest.model');
  if (
    model.surface !== 'antigravity-native-subagent'
    || model.tier !== 'flash'
    || model.expectedModel !== 'gemini-3.6-flash'
  ) {
    throw new Error('manifest.model must pin the Antigravity Flash tier and expected Gemini 3.6 Flash model');
  }

  const prompts = assertRecord(record.prompts, 'manifest.prompts');
  assertExactKeys(prompts, ['context', 'standard', 'wildcard', 'manager'], 'manifest.prompts');

  const evidence = assertRecord(record.evidence, 'manifest.evidence');
  assertExactKeys(evidence, ['file', 'sha256'], 'manifest.evidence');
  const evidenceFile = requiredString(evidence, 'file', 'manifest.evidence', 500);
  assertSafeRelativePath(evidenceFile, 'manifest.evidence.file');

  const contextSnapshot = assertRecord(record.contextSnapshot, 'manifest.contextSnapshot');
  assertExactKeys(
    contextSnapshot,
    ['file', 'sha256', 'submittedUpdatedAt'],
    'manifest.contextSnapshot',
  );
  const contextFile = requiredString(contextSnapshot, 'file', 'manifest.contextSnapshot', 500);
  assertSafeRelativePath(contextFile, 'manifest.contextSnapshot.file');
  const contextUpdatedAt = contextSnapshot.submittedUpdatedAt === null
    ? null
    : requiredIsoTimestamp(contextSnapshot, 'submittedUpdatedAt', 'manifest.contextSnapshot');

  const exportSnapshot = assertRecord(record.exportSnapshot, 'manifest.exportSnapshot');
  assertExactKeys(exportSnapshot, ['file', 'sha256'], 'manifest.exportSnapshot');
  const exportFile = requiredString(exportSnapshot, 'file', 'manifest.exportSnapshot', 500);
  assertSafeRelativePath(exportFile, 'manifest.exportSnapshot.file');

  if (!Array.isArray(record.chunks) || record.chunks.length < 1) {
    throw new Error('manifest.chunks must contain at least one chunk');
  }
  const chunks = record.chunks.map((chunk, index) => parseManifestChunk(chunk, `manifest.chunks[${index}]`));
  if (new Set(chunks.map((chunk) => chunk.type)).size !== 1) {
    throw new Error('manifest chunks must all belong to one scoring phase');
  }
  const chunkIds = chunks.map((chunk) => chunk.chunkId);
  if (new Set(chunkIds).size !== chunkIds.length) {
    throw new Error('manifest.chunks contains duplicate chunk IDs');
  }
  const jobIds = chunks.flatMap((chunk) => chunk.jobs.map((job) => job.id));
  if (new Set(jobIds).size !== jobIds.length) {
    throw new Error('manifest contains a job in more than one chunk');
  }
  chunks.forEach((chunk, index) => {
    const expectedId = `chunk_${String(index).padStart(4, '0')}`;
    if (chunk.chunkId !== expectedId) {
      throw new Error(`manifest chunks must be contiguous and ordered; expected ${expectedId}`);
    }
  });

  const parsed: NativeScoringManifest = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId,
    createdAt: requiredIsoTimestamp(record, 'createdAt', 'manifest'),
    chunkSize: NATIVE_SCORING_CHUNK_SIZE,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: 'gemini-3.6-flash',
    },
    prompts: {
      context: parsePrompt(prompts.context, 'manifest.prompts.context'),
      standard: parsePrompt(prompts.standard, 'manifest.prompts.standard'),
      wildcard: parsePrompt(prompts.wildcard, 'manifest.prompts.wildcard'),
      manager: parsePrompt(prompts.manager, 'manifest.prompts.manager'),
    },
    evidence: {
      file: evidenceFile,
      sha256: requiredSha256(evidence, 'sha256', 'manifest.evidence'),
    },
    contextSnapshot: {
      file: contextFile,
      sha256: requiredSha256(contextSnapshot, 'sha256', 'manifest.contextSnapshot'),
      submittedUpdatedAt: contextUpdatedAt,
    },
    exportSnapshot: {
      file: exportFile,
      sha256: requiredSha256(exportSnapshot, 'sha256', 'manifest.exportSnapshot'),
    },
    chunks,
    manifestHash: requiredSha256(record, 'manifestHash', 'manifest'),
  };

  const { manifestHash: submittedHash, ...unsignedManifest } = parsed;
  const computedHash = manifestHash(unsignedManifest);
  if (submittedHash !== computedHash) {
    throw new Error('manifest.manifestHash does not match the manifest contents');
  }
  return parsed;
}

function parseNativeScoringJob(value: unknown, field: string): NativeScoringJob {
  const record = assertRecord(value, field);
  assertExactKeys(
    record,
    ['id', 'title', 'company', 'location', 'description', 'submittedUpdatedAt'],
    field,
  );
  const id = requiredString(record, 'id', field, 100);
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`${field}.id must be a UUID`);
  }
  return {
    id,
    title: requiredString(record, 'title', field, 500),
    company: requiredString(record, 'company', field, 500),
    location: typeof record.location === 'string' ? record.location : (() => {
      throw new Error(`${field}.location must be a string`);
    })(),
    description: requiredString(record, 'description', field, 12_500),
    submittedUpdatedAt: requiredIsoTimestamp(record, 'submittedUpdatedAt', field),
  };
}

export function parseNativeContextProfile(value: unknown, field = 'contextProfile'): NativeContextProfile {
  const record = assertRecord(value, field);
  assertExactKeys(record, ['rulesText', 'submittedUpdatedAt'], field);
  const rulesText = requiredString(record, 'rulesText', field, 12_000);
  if (!negativeOnlyContextRules(rulesText)) {
    throw new Error(`${field}.rulesText must be a negative-only DO REJECT profile`);
  }
  return {
    rulesText,
    submittedUpdatedAt: record.submittedUpdatedAt === null
      ? null
      : requiredIsoTimestamp(record, 'submittedUpdatedAt', field),
  };
}

export function nativeContextSnapshotContents(profile: NativeContextProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

function parseContextFeedbackJob(value: unknown, field: string): NativeContextFeedbackJob {
  const record = assertRecord(value, field);
  assertExactKeys(
    record,
    ['id', 'title', 'company', 'location', 'description', 'passReason', 'submittedUpdatedAt'],
    field,
  );
  const base = parseNativeScoringJob({
    id: record.id,
    title: record.title,
    company: record.company,
    location: record.location,
    description: record.description,
    submittedUpdatedAt: record.submittedUpdatedAt,
  }, field);
  return {
    ...base,
    passReason: requiredString(record, 'passReason', field, 2_000),
  };
}

export function parseNativeScoringChunk(value: unknown): NativeScoringChunk {
  const record = assertRecord(value, 'chunk');
  const type = record.type;
  if (type === 'context' || type === 'standard') {
    assertExactKeys(
      record,
      ['schemaVersion', 'batchId', 'chunkId', 'type', 'contextProfile', 'jobs'],
      'chunk',
    );
  } else {
    assertExactKeys(record, ['schemaVersion', 'batchId', 'chunkId', 'type', 'jobs'], 'chunk');
  }
  if (record.schemaVersion !== NATIVE_SCORING_SCHEMA_VERSION) {
    throw new Error(`chunk.schemaVersion must be ${NATIVE_SCORING_SCHEMA_VERSION}`);
  }
  const batchId = requiredString(record, 'batchId', 'chunk', 160);
  if (!SAFE_BATCH_ID_PATTERN.test(batchId)) {
    throw new Error('chunk.batchId contains unsafe characters');
  }
  const chunkId = requiredString(record, 'chunkId', 'chunk', 40);
  if (!CHUNK_ID_PATTERN.test(chunkId)) {
    throw new Error('chunk.chunkId must match chunk_0000');
  }
  if (type !== 'context' && type !== 'standard' && type !== 'wildcard') {
    throw new Error('chunk.type must be context, standard, or wildcard');
  }
  if (!Array.isArray(record.jobs) || record.jobs.length < 1 || record.jobs.length > NATIVE_SCORING_CHUNK_SIZE) {
    throw new Error(`chunk.jobs must contain 1 through ${NATIVE_SCORING_CHUNK_SIZE} jobs`);
  }
  const jobs = record.jobs.map((job, index) => type === 'context'
    ? parseContextFeedbackJob(job, `chunk.jobs[${index}]`)
    : parseNativeScoringJob(job, `chunk.jobs[${index}]`));
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error('chunk.jobs contains duplicate IDs');
  }
  const common = { schemaVersion: NATIVE_SCORING_SCHEMA_VERSION, batchId, chunkId } as const;
  if (type === 'context') {
    return {
      ...common,
      type,
      contextProfile: parseNativeContextProfile(record.contextProfile, 'chunk.contextProfile'),
      jobs: jobs as NativeContextFeedbackJob[],
    };
  }
  if (type === 'standard') {
    return {
      ...common,
      type,
      contextProfile: parseNativeContextProfile(record.contextProfile, 'chunk.contextProfile'),
      jobs: jobs as NativeScoringJob[],
    };
  }
  return { ...common, type, jobs: jobs as NativeScoringJob[] };
}

function assertExpectedIds(actualIds: string[], expectedIds: string[], field: string): void {
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(`${field} must return every assigned job exactly once and in input order`);
  }
}

export function parseContextResult(
  value: unknown,
  expectedJobs: ManifestJob[],
  expectedContextUpdatedAt: string | null,
): ContextUpdateResult {
  const envelope = assertRecord(value, 'context result');
  assertExactKeys(envelope, ['contextUpdate'], 'context result');
  const update = assertRecord(envelope.contextUpdate, 'context result.contextUpdate');
  assertExactKeys(
    update,
    ['submittedContextProfileUpdatedAt', 'updatedContextRules', 'processedFeedback'],
    'context result.contextUpdate',
  );
  const submittedContextProfileUpdatedAt = update.submittedContextProfileUpdatedAt === null
    ? null
    : requiredIsoTimestamp(
      update,
      'submittedContextProfileUpdatedAt',
      'context result.contextUpdate',
    );
  if (submittedContextProfileUpdatedAt !== expectedContextUpdatedAt) {
    throw new Error('context result did not echo the submitted Context DB version');
  }
  const updatedContextRules = requiredString(
    update,
    'updatedContextRules',
    'context result.contextUpdate',
    12_000,
  );
  if (!negativeOnlyContextRules(updatedContextRules)) {
    throw new Error('context result must contain only a DO REJECT profile');
  }
  if (!Array.isArray(update.processedFeedback)) {
    throw new Error('context result.contextUpdate.processedFeedback must be an array');
  }
  const processedFeedback = update.processedFeedback.map((entry, index) => (
    parseManifestJob(entry, `context result.contextUpdate.processedFeedback[${index}]`)
  ));
  if (
    processedFeedback.length !== expectedJobs.length
    || processedFeedback.some((entry, index) => (
      entry.id !== expectedJobs[index].id
      || entry.submittedUpdatedAt !== expectedJobs[index].submittedUpdatedAt
    ))
  ) {
    throw new Error('context result must process every assigned feedback job exactly once and in order');
  }
  return {
    submittedContextProfileUpdatedAt,
    updatedContextRules,
    processedFeedback,
  };
}

export function parseStandardResult(
  value: unknown,
  expectedIds: string[],
  allowedEvidenceIds: ReadonlySet<string>,
): StandardScore[] {
  const envelope = assertRecord(value, 'standard result');
  assertExactKeys(envelope, ['standardScores'], 'standard result');
  if (!Array.isArray(envelope.standardScores)) {
    throw new Error('standard result.standardScores must be an array');
  }
  const scores = envelope.standardScores.map((entry, index): StandardScore => {
    const field = `standard result.standardScores[${index}]`;
    const record = assertRecord(entry, field);
    assertExactKeys(
      record,
      [
        'id',
        'aimFitScore',
        'experienceFitScore',
        'aimFitReason',
        'experienceFitReason',
        'travelScore',
        'evidenceIds',
      ],
      field,
    );
    const id = requiredString(record, 'id', field, 100);
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`${field}.id must be a UUID`);
    }
    if (!Array.isArray(record.evidenceIds) || record.evidenceIds.length > 6) {
      throw new Error(`${field}.evidenceIds must be an array containing at most 6 IDs`);
    }
    const evidenceIds = record.evidenceIds.map((evidenceId, evidenceIndex) => {
      if (
        typeof evidenceId !== 'string'
        || !EVIDENCE_ID_PATTERN.test(evidenceId)
        || !allowedEvidenceIds.has(evidenceId)
      ) {
        throw new Error(`${field}.evidenceIds[${evidenceIndex}] is not a known evidence ID`);
      }
      return evidenceId;
    });
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error(`${field}.evidenceIds must not contain duplicates`);
    }
    const experienceFitReason = requiredString(record, 'experienceFitReason', field, 4_000);
    evidenceIds.forEach((evidenceId) => {
      if (!experienceFitReason.includes(evidenceId)) {
        throw new Error(`${field}.experienceFitReason must cite ${evidenceId}`);
      }
    });
    return {
      id,
      aimFitScore: requiredScore(record, 'aimFitScore', field),
      experienceFitScore: requiredScore(record, 'experienceFitScore', field),
      aimFitReason: requiredString(record, 'aimFitReason', field, 4_000),
      experienceFitReason,
      travelScore: requiredScore(record, 'travelScore', field),
      evidenceIds,
    };
  });
  assertExpectedIds(scores.map((score) => score.id), expectedIds, 'standard result.standardScores');
  return scores;
}

export function parseWildcardResult(value: unknown, expectedIds: string[]): WildcardScore[] {
  const envelope = assertRecord(value, 'wildcard result');
  assertExactKeys(envelope, ['wildcardScores'], 'wildcard result');
  if (!Array.isArray(envelope.wildcardScores)) {
    throw new Error('wildcard result.wildcardScores must be an array');
  }
  const scores = envelope.wildcardScores.map((entry, index): WildcardScore => {
    const field = `wildcard result.wildcardScores[${index}]`;
    const record = assertRecord(entry, field);
    assertExactKeys(record, ['id', 'vibeFitScore', 'vibeFitReason'], field);
    const id = requiredString(record, 'id', field, 100);
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`${field}.id must be a UUID`);
    }
    return {
      id,
      vibeFitScore: requiredScore(record, 'vibeFitScore', field),
      vibeFitReason: requiredString(record, 'vibeFitReason', field, 4_000),
    };
  });
  assertExpectedIds(scores.map((score) => score.id), expectedIds, 'wildcard result.wildcardScores');
  return scores;
}
