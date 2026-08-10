import { createHash } from 'node:crypto';

import { negativeOnlyContextRules, validateTypedContextRules } from './contextFeedbackPolicy';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import {
  extractMandatoryRequirementCandidates,
  mandatoryRequirementCandidatesMatch,
  MAX_MANDATORY_REQUIREMENT_CANDIDATES,
  type MandatoryRequirementCandidate,
} from './mandatoryRequirements';

export const NATIVE_SCORING_SCHEMA_VERSION = 'native-scoring-batch-v6.7.0';
export const NATIVE_SCORING_CHUNK_SIZE = 5;
export const NATIVE_SCORING_MANAGER_WAVE_SIZE = 4;
export const NATIVE_SCORING_STANDARD_BATCH_SIZE = NATIVE_SCORING_CHUNK_SIZE * 20;
export const MAX_MANDATORY_REQUIREMENT_ASSESSMENTS = MAX_MANDATORY_REQUIREMENT_CANDIDATES;
export const MAX_UNMET_MANDATORY_REQUIREMENTS = 32;
export const NATIVE_SCORING_EXPECTED_MODEL = 'gemini-3.1-pro-high';
export const CONTEXT_PROMPT_VERSION = 'context-job-evaluator-v6.7.0';
export const STANDARD_PROMPT_VERSION = 'standard-job-evaluator-v6.10.0';
export const MANAGER_PROMPT_VERSION = 'scoring-manager-v6.7.0';

type JsonRecord = Record<string, unknown>;

export type NativeScoringType = 'context' | 'standard';

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
    tier: 'pro';
    expectedModel: typeof NATIVE_SCORING_EXPECTED_MODEL;
  };
  prompts: {
    context: ManifestPrompt;
    standard: ManifestPrompt;
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

export interface NativeStandardScoringJob extends NativeScoringJob {
  mandatoryRequirementCandidates: MandatoryRequirementCandidate[];
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
  jobs: NativeStandardScoringJob[];
}

export type NativeScoringChunk =
  | NativeContextScoringChunk
  | NativeStandardScoringChunk;

export type QualificationSupport = 'direct' | 'adjacent' | 'unsupported';

export interface MandatoryRequirementAssessment {
  requirementId: string;
  requirement: string;
  support: QualificationSupport;
  evidenceIds: string[];
  explanation: string;
}

export type RequirementScopeClass =
  | 'partner_certification_program'
  | 'formal_management_title_tenure'
  | 'people_leadership'
  | 'financial_authority'
  | 'enterprise_account_ownership'
  | 'personal_credential'
  | 'bachelors_degree'
  | 'unrestricted';

function normalizedRequirement(requirement: string): string {
  return requirement.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Pure deterministic classification for evidence scopes that may not be inferred. */
export function classifyRequirementScope(requirement: string): RequirementScopeClass {
  const normalized = normalizedRequirement(requirement);
  const certificationProgram = /\b(?:certification|credentialing)\s+(?:programs?|curricul(?:um|a)|paths?)\b/.test(normalized)
    && /\b(?:partner|channel|reseller|distributor)\b/.test(normalized)
    && /\b(?:design|designing|designed|develop|developing|developed|build|building|built|create|creating|created|launch|launching|launched|implement|implementing|implemented|administer|administering|administered|deliver|delivering|delivered|lead|leading|led)\b/.test(normalized);
  if (certificationProgram) return 'partner_certification_program';
  if (
    /\b(?:\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b.{0,80}\b(?:area|district|regional|channel|partner|sales)\s+(?:manager|director|leader)\b/.test(normalized)
    || /\b(?:area|district|regional|channel|partner|sales)\s+(?:manager|director|leader)\b.{0,80}\b(?:\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/.test(normalized)
    || /\b(?:area|district|regional|channel|partner|sales)\s+(?:manager|director|leader)\b.{0,40}\b(?:or higher|level|title|position)\b/.test(normalized)
  ) return 'formal_management_title_tenure';
  const peopleAction = /\b(?:supervis(?:e|es|ed|ing|ion)|people manag(?:e|es|ed|ing|ement)|manage|managing|managed|lead|leading|led|coach|coaching|coached|hire|hiring|disciplin(?:e|ed|ing)|direct reports?)\b/.test(normalized);
  const peopleObject = /\b(?:team|employees?|staff|direct reports?|sales representatives?|sales reps?|people)\b/.test(normalized);
  if (peopleAction && peopleObject) return 'people_leadership';
  if (/\b(?:p&l|profit and loss|full financial accountability|financial accountability|budget (?:authority|ownership|management)|own(?:ed|ership)? (?:the )?budget|departmental (?:budget|spend)|allocat(?:e|es|ed|ing)\b.{0,35}\b(?:budget|departmental spend|funds)|approv(?:e|es|ed|ing)\b.{0,35}\b(?:budget|departmental spend|funds))\b/.test(normalized)) {
    return 'financial_authority';
  }
  const ownershipAction = /\b(?:own|owns|owned|ownership|primary (?:relationship )?owner|serve as (?:the )?primary (?:relationship )?owner|directly manage)\b/.test(normalized);
  const enterpriseObject = /\b(?:enterprise|national|global|strategic|fortune\s*500|named)\b.{0,45}\b(?:accounts?|clients?|customers?|relationships?)\b/.test(normalized)
    || /\b(?:accounts?|clients?|customers?|relationships?)\b.{0,45}\b(?:enterprise|national|global|strategic|fortune\s*500|named)\b/.test(normalized);
  if (ownershipAction && enterpriseObject) return 'enterprise_account_ownership';
  if (/\bbachelor(?:'s)?(?: degree)?\b/.test(normalized)) return 'bachelors_degree';
  if (/\b(?:license|licensure|licensed|credential|credentialed|certification|certified)\b/.test(normalized)) return 'personal_credential';
  return 'unrestricted';
}

/** Returns null only when the cited IDs can directly establish the classified scope. */
export function directRequirementScopeViolation(
  requirement: string,
  evidenceIds: readonly string[],
): string | null {
  const scope = classifyRequirementScope(requirement);
  const hasEvidence = (...ids: string[]) => ids.some((id) => evidenceIds.includes(id));
  if (scope === 'partner_certification_program' && !hasEvidence('DSI-021')) {
    return 'needs DSI-021 for direct partner-certification-program evidence';
  }
  if (scope === 'formal_management_title_tenure') {
    return 'cannot mark formal management-title tenure as direct';
  }
  if (scope === 'people_leadership') {
    if (!hasEvidence('TMO-001', 'TMO-002', 'TMO-004', 'TMO-006')) {
      return 'needs direct T-Mobile people-leadership evidence';
    }
    if (/\b(?:\d+\+?|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/i.test(requirement)) {
      return 'cannot mark multi-year W-2 people leadership as direct';
    }
  }
  if (scope === 'financial_authority') return 'cannot mark P&L, financial accountability, or budget authority as direct';
  if (scope === 'enterprise_account_ownership') return 'cannot mark enterprise/national-account ownership as direct';
  if (scope === 'personal_credential') return 'cannot mark an unevidenced license, certification, or credential as direct';
  if (scope === 'bachelors_degree' && !hasEvidence('EDU-001')) return "needs EDU-001 for direct bachelor's-degree support";
  return null;
}

export interface StandardScore {
  id: string;
  aimFitScore: number;
  experienceFitScore: number;
  aimFitReason: string;
  experienceFitReason: string;
  travelScore: number;
  compensation: string | null;
  evidenceIds: string[];
  qualificationBasis: QualificationSupport;
  mandatoryRequirementAssessments: MandatoryRequirementAssessment[];
  mandatoryRequirementsMet: boolean;
  unmetMandatoryRequirements: string[];
  requiredDomain: string | null;
  candidateDomain: string | null;
  domainMatch: boolean;
  requiredYearsInDomain: number | null;
  candidateYearsInDomain: number | null;
}

export interface ContextUpdateResult {
  submittedContextProfileUpdatedAt: string | null;
  updatedContextRules: string;
  processedFeedback: ManifestJob[];
  ruleProvenance: Array<{ ruleText: string; sourceDecisionIds: string[] }>;
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

function requiredBoolean(record: JsonRecord, key: string, field: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`${field}.${key} must be a boolean`);
  return value;
}

function nullableString(
  record: JsonRecord,
  key: string,
  field: string,
  maxLength = 500,
): string | null {
  const value = record[key];
  if (value === null) return null;
  return requiredString(record, key, field, maxLength);
}

function nullableNonNegativeNumber(record: JsonRecord, key: string, field: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 80) {
    throw new Error(`${field}.${key} must be null or a finite number from 0 through 80`);
  }
  return value;
}

function boundedStringArray(record: JsonRecord, key: string, field: string, maxItems: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${field}.${key} must be an array containing at most ${maxItems} strings`);
  }
  const strings = value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 500 || entry.includes('\u0000')) {
      throw new Error(`${field}.${key}[${index}] must be a non-empty string of at most 500 characters`);
    }
    return entry.trim();
  });
  if (new Set(strings.map((entry) => entry.toLowerCase())).size !== strings.length) {
    throw new Error(`${field}.${key} must not contain duplicates`);
  }
  return strings;
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
  if (record.type !== 'context' && record.type !== 'standard') {
    throw new Error(`${field}.type must be context or standard`);
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
    || model.tier !== 'pro'
    || model.expectedModel !== NATIVE_SCORING_EXPECTED_MODEL
  ) {
    throw new Error('manifest.model must pin Gemini 3.6 Flash with high reasoning');
  }

  const prompts = assertRecord(record.prompts, 'manifest.prompts');
  assertExactKeys(prompts, ['context', 'standard', 'manager'], 'manifest.prompts');

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

  const parsedPrompts = {
    context: parsePrompt(prompts.context, 'manifest.prompts.context'),
    standard: parsePrompt(prompts.standard, 'manifest.prompts.standard'),
    manager: parsePrompt(prompts.manager, 'manifest.prompts.manager'),
  };
  const expectedPrompts = {
    context: {
      version: CONTEXT_PROMPT_VERSION,
      file: '.agents/agents/context-job-evaluator-v6/agent.md',
    },
    standard: {
      version: STANDARD_PROMPT_VERSION,
      file: '.agents/agents/standard-job-evaluator-v6/agent.md',
    },
    manager: {
      version: MANAGER_PROMPT_VERSION,
      file: '.agents/agents/scoring-manager-v6/agent.md',
    },
  } as const;
  for (const promptName of ['context', 'standard', 'manager'] as const) {
    const actual = parsedPrompts[promptName];
    const expected = expectedPrompts[promptName];
    if (actual.version !== expected.version || actual.file !== expected.file) {
      throw new Error(
        `manifest.prompts.${promptName} must bind ${expected.version} at ${expected.file}`,
      );
    }
  }

  const parsed: NativeScoringManifest = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId,
    createdAt: requiredIsoTimestamp(record, 'createdAt', 'manifest'),
    chunkSize: NATIVE_SCORING_CHUNK_SIZE,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'pro',
      expectedModel: NATIVE_SCORING_EXPECTED_MODEL,
    },
    prompts: parsedPrompts,
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

function parseMandatoryRequirementCandidate(
  value: unknown,
  field: string,
): MandatoryRequirementCandidate {
  const record = assertRecord(value, field);
  assertExactKeys(
    record,
    ['requirementId', 'text', 'source', 'sourceSpan', 'mandatoryByText'],
    field,
  );
  const requirementId = requiredString(record, 'requirementId', field, 40);
  if (!/^req-[a-f0-9]{24}$/.test(requirementId)) {
    throw new Error(`${field}.requirementId must be a deterministic requirement ID`);
  }
  if (!['explicit_section', 'mandatory_language', 'core_function'].includes(String(record.source))) {
    throw new Error(`${field}.source is invalid`);
  }
  const span = assertRecord(record.sourceSpan, `${field}.sourceSpan`);
  assertExactKeys(span, ['start', 'end'], `${field}.sourceSpan`);
  if (
    !Number.isInteger(span.start)
    || !Number.isInteger(span.end)
    || Number(span.start) < 0
    || Number(span.end) < Number(span.start)
  ) {
    throw new Error(`${field}.sourceSpan must contain non-negative ordered integer offsets`);
  }
  return {
    requirementId,
    text: requiredString(record, 'text', field, 500),
    source: record.source as MandatoryRequirementCandidate['source'],
    sourceSpan: { start: Number(span.start), end: Number(span.end) },
    mandatoryByText: requiredBoolean(record, 'mandatoryByText', field),
  };
}

function parseNativeStandardScoringJob(value: unknown, field: string): NativeStandardScoringJob {
  const record = assertRecord(value, field);
  assertExactKeys(
    record,
    [
      'id',
      'title',
      'company',
      'location',
      'description',
      'mandatoryRequirementCandidates',
      'submittedUpdatedAt',
    ],
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
  if (
    !Array.isArray(record.mandatoryRequirementCandidates)
    || record.mandatoryRequirementCandidates.length < 1
    || record.mandatoryRequirementCandidates.length > MAX_MANDATORY_REQUIREMENT_CANDIDATES
  ) {
    throw new Error(
      `${field}.mandatoryRequirementCandidates must contain 1 through ${MAX_MANDATORY_REQUIREMENT_CANDIDATES} items`,
    );
  }
  const mandatoryRequirementCandidates = record.mandatoryRequirementCandidates.map((candidate, index) => (
    parseMandatoryRequirementCandidate(candidate, `${field}.mandatoryRequirementCandidates[${index}]`)
  ));
  if (new Set(mandatoryRequirementCandidates.map((candidate) => candidate.requirementId)).size !== mandatoryRequirementCandidates.length) {
    throw new Error(`${field}.mandatoryRequirementCandidates contains duplicate requirement IDs`);
  }
  const expected = extractMandatoryRequirementCandidates(base.description, base.title);
  if (!mandatoryRequirementCandidatesMatch(mandatoryRequirementCandidates, expected)) {
    throw new Error(`${field}.mandatoryRequirementCandidates do not match the deterministic JD extraction`);
  }
  return { ...base, mandatoryRequirementCandidates };
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
  assertExactKeys(
    record,
    ['schemaVersion', 'batchId', 'chunkId', 'type', 'contextProfile', 'jobs'],
    'chunk',
  );
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
  if (type !== 'context' && type !== 'standard') {
    throw new Error('chunk.type must be context or standard');
  }
  if (!Array.isArray(record.jobs) || record.jobs.length < 1 || record.jobs.length > NATIVE_SCORING_CHUNK_SIZE) {
    throw new Error(`chunk.jobs must contain 1 through ${NATIVE_SCORING_CHUNK_SIZE} jobs`);
  }
  const jobs = record.jobs.map((job, index) => type === 'context'
    ? parseContextFeedbackJob(job, `chunk.jobs[${index}]`)
    : parseNativeStandardScoringJob(job, `chunk.jobs[${index}]`));
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
    for (const [index, job] of (jobs as NativeStandardScoringJob[]).entries()) {
      const quality = assessJobDescriptionQuality(job.description);
      if (!quality.scorable) {
        throw new Error(`chunk.jobs[${index}].description is not scorable: ${quality.reason}`);
      }
    }
    return {
      ...common,
      type,
      contextProfile: parseNativeContextProfile(record.contextProfile, 'chunk.contextProfile'),
      jobs: jobs as NativeStandardScoringJob[],
    };
  }
  throw new Error('chunk.type must be context or standard');
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
  previousContextRules = '',
): ContextUpdateResult {
  const envelope = assertRecord(value, 'context result');
  assertExactKeys(envelope, ['contextUpdate'], 'context result');
  const update = assertRecord(envelope.contextUpdate, 'context result.contextUpdate');
  assertExactKeys(
    update,
    ['submittedContextProfileUpdatedAt', 'updatedContextRules', 'processedFeedback', 'ruleProvenance'],
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
  if (!Array.isArray(update.ruleProvenance)) {
    throw new Error('context result.contextUpdate.ruleProvenance must be an array');
  }
  const expectedJobIds = new Set(expectedJobs.map((job) => job.id));
  const ruleProvenance = update.ruleProvenance.map((entry, index) => {
    const field = `context result.contextUpdate.ruleProvenance[${index}]`;
    const record = assertRecord(entry, field);
    assertExactKeys(record, ['ruleText', 'sourceDecisionIds'], field);
    if (!Array.isArray(record.sourceDecisionIds)) {
      throw new Error(`${field}.sourceDecisionIds must be an array`);
    }
    const sourceDecisionIds = record.sourceDecisionIds.map((id, decisionIndex) => {
      if (typeof id !== 'string' || !expectedJobIds.has(id)) {
        throw new Error(`${field}.sourceDecisionIds[${decisionIndex}] must be an assigned feedback job ID`);
      }
      return id;
    });
    if (new Set(sourceDecisionIds).size !== sourceDecisionIds.length) {
      throw new Error(`${field}.sourceDecisionIds must not contain duplicates`);
    }
    return {
      ruleText: requiredString(record, 'ruleText', field, 2_000).trim(),
      sourceDecisionIds,
    };
  });
  const previousRules = validateTypedContextRules(previousContextRules).accepted;
  const updatedRules = validateTypedContextRules(updatedContextRules).accepted;
  const previousRuleIds = new Set(previousRules.map((rule) => rule.id));
  if (
    ruleProvenance.length !== updatedRules.length
    || updatedRules.some((rule, index) => ruleProvenance[index]?.ruleText !== rule.text)
  ) {
    throw new Error('context result ruleProvenance must cover every resulting rule exactly once and in order');
  }
  for (const [index, rule] of updatedRules.entries()) {
    const sources = ruleProvenance[index].sourceDecisionIds;
    if (previousRuleIds.has(rule.id) && sources.length !== 0) {
      throw new Error('unchanged Context rules cannot absorb unrelated source decision IDs');
    }
    if (!previousRuleIds.has(rule.id) && sources.length === 0) {
      throw new Error('every new or changed Context rule requires at least one source decision ID');
    }
  }
  return {
    submittedContextProfileUpdatedAt,
    updatedContextRules,
    processedFeedback,
    ruleProvenance,
  };
}

export function parseStandardResult(
  value: unknown,
  expectedIds: string[],
  allowedEvidenceIds: ReadonlySet<string>,
  expectedRequirementCandidatesByJob?: ReadonlyMap<string, readonly MandatoryRequirementCandidate[]>,
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
        'compensation',
        'evidenceIds',
        'qualificationBasis',
        'mandatoryRequirementAssessments',
        'mandatoryRequirementsMet',
        'unmetMandatoryRequirements',
        'requiredDomain',
        'candidateDomain',
        'domainMatch',
        'requiredYearsInDomain',
        'candidateYearsInDomain',
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
    const qualificationBasis = record.qualificationBasis;
    if (
      qualificationBasis !== 'direct'
      && qualificationBasis !== 'adjacent'
      && qualificationBasis !== 'unsupported'
    ) {
      throw new Error(`${field}.qualificationBasis must be direct, adjacent, or unsupported`);
    }
    if (
      !Array.isArray(record.mandatoryRequirementAssessments)
      || record.mandatoryRequirementAssessments.length < 1
      || record.mandatoryRequirementAssessments.length > MAX_MANDATORY_REQUIREMENT_ASSESSMENTS
    ) {
      throw new Error(`${field}.mandatoryRequirementAssessments must contain 1 through ${MAX_MANDATORY_REQUIREMENT_ASSESSMENTS} items`);
    }
    const mandatoryRequirementAssessments = record.mandatoryRequirementAssessments.map(
      (assessment, assessmentIndex): MandatoryRequirementAssessment => {
        const assessmentField = `${field}.mandatoryRequirementAssessments[${assessmentIndex}]`;
        const assessmentRecord = assertRecord(assessment, assessmentField);
        assertExactKeys(
          assessmentRecord,
          ['requirementId', 'requirement', 'support', 'evidenceIds', 'explanation'],
          assessmentField,
        );
        const requirementId = requiredString(assessmentRecord, 'requirementId', assessmentField, 40);
        if (!/^req-[a-f0-9]{24}$/.test(requirementId)) {
          throw new Error(`${assessmentField}.requirementId must be a deterministic requirement ID`);
        }
        if (
          assessmentRecord.support !== 'direct'
          && assessmentRecord.support !== 'adjacent'
          && assessmentRecord.support !== 'unsupported'
        ) {
          throw new Error(`${assessmentField}.support must be direct, adjacent, or unsupported`);
        }
        if (!Array.isArray(assessmentRecord.evidenceIds) || assessmentRecord.evidenceIds.length > 6) {
          throw new Error(`${assessmentField}.evidenceIds must contain at most 6 evidence IDs`);
        }
        const assessmentEvidenceIds = assessmentRecord.evidenceIds.map((evidenceId, evidenceIndex) => {
          if (
            typeof evidenceId !== 'string'
            || !EVIDENCE_ID_PATTERN.test(evidenceId)
            || !allowedEvidenceIds.has(evidenceId)
          ) {
            throw new Error(`${assessmentField}.evidenceIds[${evidenceIndex}] is not a known evidence ID`);
          }
          return evidenceId;
        });
        if (new Set(assessmentEvidenceIds).size !== assessmentEvidenceIds.length) {
          throw new Error(`${assessmentField}.evidenceIds must not contain duplicates`);
        }
        if (assessmentRecord.support === 'unsupported' && assessmentEvidenceIds.length > 0) {
          throw new Error(`${assessmentField}.unsupported requirements cannot cite supporting evidence`);
        }
        if (assessmentRecord.support !== 'unsupported' && assessmentEvidenceIds.length === 0) {
          throw new Error(`${assessmentField}.supported requirements must cite evidence`);
        }
        const explanation = requiredString(assessmentRecord, 'explanation', assessmentField, 1_000).trim();
        const explanationEvidenceIds = [...new Set(explanation.match(/\b[A-Z][A-Z0-9]*-\d{3}\b/g) || [])];
        for (const evidenceId of assessmentEvidenceIds) {
          if (!explanationEvidenceIds.includes(evidenceId)) {
            throw new Error(`${assessmentField}.explanation must cite ${evidenceId}`);
          }
        }
        for (const evidenceId of explanationEvidenceIds) {
          if (!assessmentEvidenceIds.includes(evidenceId)) {
            throw new Error(`${assessmentField}.explanation cites ${evidenceId} outside its evidenceIds`);
          }
        }
        return {
          requirementId,
          requirement: requiredString(assessmentRecord, 'requirement', assessmentField, 500).trim(),
          support: assessmentRecord.support,
          evidenceIds: assessmentEvidenceIds,
          explanation,
        };
      },
    );
    const expectedRequirementCandidates = expectedRequirementCandidatesByJob?.get(id);
    if (expectedRequirementCandidates) {
      if (mandatoryRequirementAssessments.length !== expectedRequirementCandidates.length) {
        throw new Error(`${field}.mandatoryRequirementAssessments must cover every assigned requirement candidate exactly once`);
      }
      for (const [candidateIndex, candidate] of expectedRequirementCandidates.entries()) {
        const assessment = mandatoryRequirementAssessments[candidateIndex];
        if (
          assessment.requirementId !== candidate.requirementId
          || assessment.requirement.trim() !== candidate.text.trim()
        ) {
          throw new Error(
            `${field}.mandatoryRequirementAssessments must preserve exact ordered requirement IDs and text`,
          );
        }
      }
    }
    const derivedQualificationBasis: QualificationSupport = mandatoryRequirementAssessments.some(
      (assessment) => assessment.support === 'unsupported',
    )
      ? 'unsupported'
      : mandatoryRequirementAssessments.some((assessment) => assessment.support === 'adjacent')
        ? 'adjacent'
        : 'direct';
    if (qualificationBasis !== derivedQualificationBasis) {
      throw new Error(`${field}.qualificationBasis does not match the mandatory requirement assessments`);
    }
    const aimFitReason = requiredString(record, 'aimFitReason', field, 4_000);
    const experienceFitReason = requiredString(record, 'experienceFitReason', field, 4_000);
    const scopeNarrative = [
      aimFitReason,
      experienceFitReason,
      ...mandatoryRequirementAssessments.map((assessment) => assessment.explanation),
    ].join('\n');
    if (
      /\b(?:held|formal|official|claimed|served as|worked as|title (?:was|of))\b.{0,80}\bchannel account manager\b/i.test(scopeNarrative)
      || /\b(?:six|6(?:\.0)?|6\.5)\+?\s+years?\b.{0,80}\b(?:as (?:a )?)?channel account manager\b/i.test(scopeNarrative)
    ) {
      throw new Error(`${field}.experienceFitReason misstates Channel Account Manager as a held title or title tenure`);
    }
    evidenceIds.forEach((evidenceId) => {
      if (!experienceFitReason.includes(evidenceId)) {
        throw new Error(`${field}.experienceFitReason must cite ${evidenceId}`);
      }
    });
    const mandatoryRequirementsMet = requiredBoolean(record, 'mandatoryRequirementsMet', field);
    const unmetMandatoryRequirements = boundedStringArray(
      record,
      'unmetMandatoryRequirements',
      field,
      MAX_UNMET_MANDATORY_REQUIREMENTS,
    );
    if (mandatoryRequirementsMet !== (unmetMandatoryRequirements.length === 0)) {
      throw new Error(`${field}.mandatoryRequirementsMet must be true exactly when unmetMandatoryRequirements is empty`);
    }
    const unsupportedRequirements = mandatoryRequirementAssessments
      .filter((assessment) => assessment.support === 'unsupported')
      .map((assessment) => assessment.requirement);
    if (
      unsupportedRequirements.length !== unmetMandatoryRequirements.length
      || unsupportedRequirements.some((requirement, requirementIndex) => (
        requirement.toLowerCase() !== unmetMandatoryRequirements[requirementIndex].toLowerCase()
      ))
    ) {
      throw new Error(`${field}.unmetMandatoryRequirements must exactly match unsupported assessments`);
    }
    for (const [assessmentIndex, assessment] of mandatoryRequirementAssessments.entries()) {
      if (assessment.support !== 'direct') continue;
      const assessmentField = `${field}.mandatoryRequirementAssessments[${assessmentIndex}]`;
      const violation = directRequirementScopeViolation(assessment.requirement, assessment.evidenceIds);
      if (violation) throw new Error(`${assessmentField} ${violation}`);
    }
    const requiredDomain = nullableString(record, 'requiredDomain', field);
    const candidateDomain = nullableString(record, 'candidateDomain', field);
    const domainMatch = requiredBoolean(record, 'domainMatch', field);
    const requiredYearsInDomain = nullableNonNegativeNumber(record, 'requiredYearsInDomain', field);
    const candidateYearsInDomain = nullableNonNegativeNumber(record, 'candidateYearsInDomain', field);
    if (requiredDomain === null && !domainMatch) {
      throw new Error(`${field}.domainMatch must be true when requiredDomain is null`);
    }
    if (requiredDomain !== null && domainMatch && candidateDomain === null) {
      throw new Error(`${field}.candidateDomain is required when a required domain is matched`);
    }
    if (candidateDomain?.startsWith('Adjacent:') && qualificationBasis === 'direct') {
      throw new Error(`${field}.qualificationBasis cannot be direct when candidateDomain is adjacent`);
    }
    if (
      requiredDomain !== null
      && domainMatch
      && candidateDomain !== null
      && !candidateDomain.startsWith('Adjacent:')
      && /\b(?:saas|software|cloud|cybersecurity|information security|medical device|clinical|reimbursement|payer|legal)\b/i.test(requiredDomain)
    ) {
      throw new Error(`${field}.candidateDomain must label unsupported specialized-domain transfer as adjacent`);
    }
    if (requiredYearsInDomain !== null && requiredDomain === null) {
      throw new Error(`${field}.requiredYearsInDomain requires a non-null requiredDomain`);
    }
    if (!domainMatch && mandatoryRequirementsMet) {
      throw new Error(`${field}.mandatoryRequirementsMet cannot be true when domainMatch is false`);
    }
    if (
      requiredYearsInDomain !== null
      && (candidateYearsInDomain === null || candidateYearsInDomain < requiredYearsInDomain)
      && mandatoryRequirementsMet
    ) {
      throw new Error(`${field}.mandatoryRequirementsMet cannot be true when required domain tenure is unsupported`);
    }
    return {
      id,
      aimFitScore: requiredScore(record, 'aimFitScore', field),
      experienceFitScore: requiredScore(record, 'experienceFitScore', field),
      aimFitReason,
      experienceFitReason,
      travelScore: requiredScore(record, 'travelScore', field),
      compensation: nullableString(record, 'compensation', field, 300),
      evidenceIds,
      qualificationBasis,
      mandatoryRequirementAssessments,
      mandatoryRequirementsMet,
      unmetMandatoryRequirements,
      requiredDomain,
      candidateDomain,
      domainMatch,
      requiredYearsInDomain,
      candidateYearsInDomain,
    };
  });
  assertExpectedIds(scores.map((score) => score.id), expectedIds, 'standard result.standardScores');
  return scores;
}
