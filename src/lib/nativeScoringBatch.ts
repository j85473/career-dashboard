import { createHash } from 'node:crypto';

import { negativeOnlyContextRules, validateTypedContextRules } from './contextFeedbackPolicy';
import {
  extractMandatoryRequirementCandidates,
  mandatoryRequirementCandidatesMatch,
  MAX_MANDATORY_REQUIREMENT_CANDIDATES,
  type MandatoryRequirementCandidate,
} from './mandatoryRequirements';
import {
  assertNativeScoringEvaluationPacket,
  containsProfessionalCredential,
  extractExplicitCompensation,
  extractTravelRange,
  type TravelRange,
} from './nativeScoringPacket';
import {
  deriveCriterionExperienceScore,
  type CriterionOutcome,
} from './scoringPolicy';

export const NATIVE_SCORING_SCHEMA_VERSION = 'native-scoring-batch-v7.0.0';
export const NATIVE_SCORING_CHUNK_SIZE = 5;
export const NATIVE_SCORING_MANAGER_WAVE_SIZE = 4;
export const NATIVE_SCORING_STANDARD_BATCH_SIZE = NATIVE_SCORING_CHUNK_SIZE * 20;
export const MAX_MANDATORY_REQUIREMENT_ASSESSMENTS = MAX_MANDATORY_REQUIREMENT_CANDIDATES;
export const MAX_UNMET_MANDATORY_REQUIREMENTS = 32;
export const NATIVE_SCORING_EXPECTED_MODEL = 'gemini-3.6-flash-high';
export const CONTEXT_PROMPT_VERSION = 'context-job-evaluator-v6.7.1';
export const STANDARD_PROMPT_VERSION = 'standard-job-evaluator-v7.0.0';
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
    tier: 'flash';
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
  evaluationPacket: string;
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
  originalRequirement: string;
  classification: 'required' | 'preferred';
  sourceSection: MandatoryRequirementCandidate['sourceSection'];
  outcome: CriterionOutcome;
  scoreNeutral: boolean;
  evidenceIds: string[];
  conflictEvidenceIds: string[];
  rationale: string;
}

export type RequirementScopeClass =
  | 'drivers_license'
  | 'administrative_eligibility'
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

type BinaryCredentialScope = Extract<RequirementScopeClass, 'drivers_license' | 'personal_credential'>;

export type AdministrativeEligibilityClass = 'none' | 'administrative_only' | 'mixed';

const EXACT_BINARY_CREDENTIAL_EVIDENCE: Readonly<Record<BinaryCredentialScope, ReadonlySet<string>>> = {
  // The current canonical evidence inventory establishes neither a current
  // driver's license nor a candidate-owned professional credential. Field
  // travel and territory work are not substitutes for either binary fact.
  drivers_license: new Set(),
  personal_credential: new Set(),
};

function isPartnerCertificationProgram(normalized: string): boolean {
  return /\b(?:certification|credentialing)\s+(?:programs?|curricul(?:um|a)|paths?)\b/.test(normalized)
    && /\b(?:partner|channel|reseller|distributor)\b/.test(normalized)
    && /\b(?:design|designing|designed|develop|developing|developed|build|building|built|create|creating|created|launch|launching|launched|implement|implementing|implemented|administer|administering|administered|deliver|delivering|delivered|lead|leading|led)\b/.test(normalized);
}

function isSoftwareLicenseRequirement(normalized: string): boolean {
  return (
    /\b(?:software|saas|cloud|platform|application|product|technology|vendor|microsoft|oracle|sap)[\s-]+(?:product[\s-]+)?licen[cs](?:e|es|ed)\b/.test(normalized)
    || /\blicen[cs](?:e|es|ed)[\s-]+(?:software|saas|cloud|platform|application|product|technology)\b/.test(normalized)
  );
}

function binaryCredentialScope(normalized: string): BinaryCredentialScope | null {
  if (
    /\bdriver(?:'|’)?s?[\s-]+licen[cs]e\b/.test(normalized)
    || /\bcommercial[\s-]+driver(?:'|’)?s?[\s-]+licen[cs]e\b/.test(normalized)
    || /\bclass[\s-]+[a-z0-9-]+[\s-]+(?:driver(?:'|’)?s?[\s-]+)?licen[cs]e\b/.test(normalized)
    || /\blicen[cs]e\b.{0,50}\b(?:driving|motor vehicle|mvr)\b/.test(normalized)
    || /\b(?:clean|acceptable|satisfactory|safe)[\s-]+(?:driving|motor[\s-]+vehicle)[\s-]+record\b/.test(normalized)
    || /\bmvr\b.{0,30}\b(?:eligible|eligibility|record|check)\b/.test(normalized)
  ) return 'drivers_license';
  if (isPartnerCertificationProgram(normalized) || isSoftwareLicenseRequirement(normalized)) {
    return null;
  }
  if (/\b(?:licen[cs]e|licensure|licensed|credential|credentialed|certification|certified)\b/.test(normalized)) {
    return 'personal_credential';
  }
  return null;
}

function hasAdministrativeEligibilityFact(normalized: string): boolean {
  if (binaryCredentialScope(normalized) === 'drivers_license') return true;
  return (
    /\b(?:reliable|personal|own)[\s-]+(?:transportation|vehicle|car|automobile)\b/.test(normalized)
    || /\baccess to (?:a[\s-]+)?(?:reliable[\s-]+)?(?:vehicle|car|transportation)\b/.test(normalized)
    || /\b(?:proof of|valid|current)[\s-]+(?:personal[\s-]+)?(?:auto|automobile|vehicle)[\s-]+insurance\b/.test(normalized)
    || /\bproof of (?:current[\s-]+)?insurance\b/.test(normalized)
    || /\b(?:work|employment)[\s-]+authori[sz]ation\b/.test(normalized)
    || /\b(?:legally[\s-]+)?authori[sz]ed to work\b/.test(normalized)
    || /\b(?:eligible|eligibility|right) to work\b/.test(normalized)
    || /\b(?:visa|immigration)[\s-]+sponsorship\b/.test(normalized)
    || /\b(?:background|criminal history)[\s-]+(?:check|screen|screening|investigation)\b/.test(normalized)
    || /\bdrug[\s-]+(?:test|testing|screen|screening)\b/.test(normalized)
    || /\bsecurity[\s-]+clearance\b/.test(normalized)
    || /\b(?:18|21)[\s-]+years? (?:old|of age)\b/.test(normalized)
  );
}

function hasQualificationBearingClause(normalized: string): boolean {
  return (
    /\b\d+(?:\.\d+)?\+?[\s-]+years?\b.{0,80}\b(?:experience|sales|management|leadership|knowledge)\b/.test(normalized)
    || /\b(?:experience|degree|education|knowledge|skills?|proficien(?:cy|t)|sales|customer|account|management|manage|leadership|technical|clinical|nursing|property[\s&-]+casualty|p&c|lift(?:ing)?)\b/.test(normalized)
  );
}

export function isMixedProfessionalCredentialRequirement(requirement: string): boolean {
  const normalized = normalizedRequirement(requirement);
  return binaryCredentialScope(normalized) === 'personal_credential'
    && /\b(?:\d+(?:\.\d+)?\+?\s*years?|experience|degree|education|knowledge|skills?|proficien(?:cy|t)|sales|customer|account|management|leadership|technical)\b/.test(normalized);
}

/**
 * Administrative eligibility is score-neutral. A mixed candidate remains
 * qualification-relevant because its experience-bearing clauses still need a
 * truthful support decision.
 */
export function classifyAdministrativeEligibilityRequirement(
  requirement: string,
): AdministrativeEligibilityClass {
  const normalized = normalizedRequirement(requirement);
  if (!hasAdministrativeEligibilityFact(normalized)) return 'none';
  return hasQualificationBearingClause(normalized) ? 'mixed' : 'administrative_only';
}

/** Pure deterministic classification for evidence scopes that may not be inferred. */
export function classifyRequirementScope(requirement: string): RequirementScopeClass {
  const normalized = normalizedRequirement(requirement);
  const administrativeClass = classifyAdministrativeEligibilityRequirement(requirement);
  const credentialScope = binaryCredentialScope(normalized);
  if (administrativeClass === 'administrative_only') {
    return credentialScope === 'drivers_license'
      ? 'drivers_license'
      : 'administrative_eligibility';
  }
  if (credentialScope === 'personal_credential') return credentialScope;
  if (isPartnerCertificationProgram(normalized)) return 'partner_certification_program';
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
  if (scope === 'drivers_license' || scope === 'administrative_eligibility') {
    return 'administrative eligibility must be reported as unsupported and score-neutral';
  }
  if (scope === 'personal_credential') {
    const authorizedEvidence = EXACT_BINARY_CREDENTIAL_EVIDENCE[scope];
    if (!evidenceIds.some((evidenceId) => authorizedEvidence.has(evidenceId))) {
      return 'needs exact authorized evidence for the candidate-owned license, certification, or credential';
    }
  }
  if (scope === 'bachelors_degree' && !hasEvidence('EDU-001')) return "needs EDU-001 for direct bachelor's-degree support";
  return null;
}

/**
 * Enforces support-level rules that cannot be inferred through transferable
 * work experience. Binary credentials are either exactly evidenced or
 * unsupported; they can never be satisfied by adjacent evidence.
 */
export function requirementScopeViolation(
  requirement: string,
  support: QualificationSupport,
  evidenceIds: readonly string[],
): string | null {
  const administrativeClass = classifyAdministrativeEligibilityRequirement(requirement);
  if (administrativeClass === 'administrative_only') {
    return support === 'unsupported'
      ? null
      : 'administrative eligibility must be reported as unsupported and score-neutral';
  }
  if (support === 'unsupported') return null;
  const scope = classifyRequirementScope(requirement);
  if (
    support === 'adjacent'
    && scope === 'personal_credential'
  ) {
    return 'cannot mark a binary candidate-owned license, certification, or credential as adjacent';
  }
  return support === 'direct'
    ? directRequirementScopeViolation(requirement, evidenceIds)
    : null;
}

export interface StandardScore {
  id: string;
  aimFitScore: number;
  experienceFitScore: number;
  aimFitReason: string;
  experienceFitReason: string;
  travelScore: number;
  travelRange: TravelRange;
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

export function parseNativeResultDocument(raw: string | Buffer, chunkId: string): unknown {
  const text = raw.toString('utf8').trim();
  const rejected = /^EVALUATION_INPUT_ERROR:\s*([\s\S]+)$/i.exec(text);
  if (rejected) {
    throw new Error(`${chunkId} evaluator rejected its sanitized input: ${rejected[1].trim()}`);
  }
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(
      `${chunkId} result is not bare JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
    || model.expectedModel !== NATIVE_SCORING_EXPECTED_MODEL
  ) {
    throw new Error('manifest.model must pin Gemini 3.6 Flash High (gemini-3.6-flash-high)');
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
      tier: 'flash',
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
    ['id', 'title', 'company', 'location', 'evaluationPacket', 'submittedUpdatedAt'],
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
    evaluationPacket: requiredString(record, 'evaluationPacket', field, 12_500),
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
    ['requirementId', 'text', 'originalText', 'classification', 'sourceSection', 'source', 'sourceSpan', 'mandatoryByText'],
    field,
  );
  const requirementId = requiredString(record, 'requirementId', field, 40);
  if (!/^req-[a-f0-9]{24}$/.test(requirementId)) {
    throw new Error(`${field}.requirementId must be a deterministic requirement ID`);
  }
  if (!['explicit_section', 'mandatory_language', 'core_function'].includes(String(record.source))) {
    throw new Error(`${field}.source is invalid`);
  }
  if (record.classification !== 'required' && record.classification !== 'preferred') {
    throw new Error(`${field}.classification must be required or preferred`);
  }
  if (!['REQUIRED EXPERIENCE', 'PREFERRED EXPERIENCE', 'ROLE-DEFINING QUALIFICATIONS', 'OTHER'].includes(String(record.sourceSection))) {
    throw new Error(`${field}.sourceSection is invalid`);
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
    originalText: requiredString(record, 'originalText', field, 500),
    classification: record.classification as MandatoryRequirementCandidate['classification'],
    sourceSection: record.sourceSection as MandatoryRequirementCandidate['sourceSection'],
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
      'evaluationPacket',
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
    evaluationPacket: record.evaluationPacket,
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
  if (mandatoryRequirementCandidates.some((candidate) => isMixedProfessionalCredentialRequirement(candidate.text))) {
    throw new Error(`${field}.mandatoryRequirementCandidates must separate professional credentials from experience clauses`);
  }
  assertNativeScoringEvaluationPacket(base.evaluationPacket);
  const expected = extractMandatoryRequirementCandidates(base.evaluationPacket, base.title);
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
    ['id', 'title', 'company', 'location', 'evaluationPacket', 'passReason', 'submittedUpdatedAt'],
    field,
  );
  const base = parseNativeScoringJob({
    id: record.id,
    title: record.title,
    company: record.company,
    location: record.location,
    evaluationPacket: record.evaluationPacket,
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

function parseCriterionEvidenceIds(
  value: unknown,
  field: string,
  allowedEvidenceIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.length > 6) {
    throw new Error(`${field} must contain at most 6 evidence IDs`);
  }
  const ids = value.map((evidenceId, index) => {
    if (
      typeof evidenceId !== 'string'
      || !EVIDENCE_ID_PATTERN.test(evidenceId)
      || !allowedEvidenceIds.has(evidenceId)
    ) {
      throw new Error(`${field}[${index}] is not a known evidence ID`);
    }
    return evidenceId;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicates`);
  return ids;
}

/**
 * Parses only criterion decisions from Agy, then derives every aggregate and
 * JD projection in application code. Holistic Experience, salary, and travel
 * fields in model output are rejected by the exact-key contract.
 */
export function parseStandardResult(
  value: unknown,
  expectedIds: string[],
  allowedEvidenceIds: ReadonlySet<string>,
  expectedRequirementCandidatesByJob?: ReadonlyMap<string, readonly MandatoryRequirementCandidate[]>,
  expectedEvaluationPacketsByJob?: ReadonlyMap<string, string>,
): StandardScore[] {
  if (!expectedRequirementCandidatesByJob || !expectedEvaluationPacketsByJob) {
    throw new Error('criterion result validation requires bound candidates and evaluation packets');
  }
  const evidencePrefixes = new Set([...allowedEvidenceIds].map((evidenceId) => evidenceId.split('-', 1)[0]));
  const envelope = assertRecord(value, 'standard result');
  assertExactKeys(envelope, ['standardScores'], 'standard result');
  if (!Array.isArray(envelope.standardScores)) {
    throw new Error('standard result.standardScores must be an array');
  }

  const scores = envelope.standardScores.map((entry, index): StandardScore => {
    const field = `standard result.standardScores[${index}]`;
    const record = assertRecord(entry, field);
    assertExactKeys(record, ['id', 'aimFitScore', 'aimFitReason', 'criterionAssessments'], field);
    const id = requiredString(record, 'id', field, 100);
    if (!UUID_PATTERN.test(id)) throw new Error(`${field}.id must be a UUID`);
    const candidates = expectedRequirementCandidatesByJob.get(id);
    const packet = expectedEvaluationPacketsByJob.get(id);
    if (!candidates || !packet) throw new Error(`${field} is missing bound criterion or packet provenance`);
    if (!Array.isArray(record.criterionAssessments) || record.criterionAssessments.length !== candidates.length) {
      throw new Error(`${field}.criterionAssessments must cover every supplied criterion exactly once`);
    }

    const assessments = record.criterionAssessments.map((assessment, assessmentIndex): MandatoryRequirementAssessment => {
      const assessmentField = `${field}.criterionAssessments[${assessmentIndex}]`;
      const assessmentRecord = assertRecord(assessment, assessmentField);
      assertExactKeys(
        assessmentRecord,
        ['requirementId', 'outcome', 'evidenceIds', 'conflictEvidenceIds', 'rationale'],
        assessmentField,
      );
      const candidate = candidates[assessmentIndex];
      const requirementId = requiredString(assessmentRecord, 'requirementId', assessmentField, 40);
      if (requirementId !== candidate.requirementId) {
        throw new Error(`${field}.criterionAssessments must preserve exact ordered requirement IDs`);
      }
      const outcome = assessmentRecord.outcome;
      if (!['direct', 'partial', 'cannot_evaluate', 'does_not_meet'].includes(String(outcome))) {
        throw new Error(`${assessmentField}.outcome must be direct, partial, cannot_evaluate, or does_not_meet; Agy cannot return excluded`);
      }
      const evidenceIds = parseCriterionEvidenceIds(
        assessmentRecord.evidenceIds,
        `${assessmentField}.evidenceIds`,
        allowedEvidenceIds,
      );
      const conflictEvidenceIds = parseCriterionEvidenceIds(
        assessmentRecord.conflictEvidenceIds,
        `${assessmentField}.conflictEvidenceIds`,
        allowedEvidenceIds,
      );
      const rationale = requiredString(assessmentRecord, 'rationale', assessmentField, 1_000).trim();
      const typedOutcome = outcome as Exclude<CriterionOutcome, 'excluded'>;

      if ((typedOutcome === 'direct' || typedOutcome === 'partial') && evidenceIds.length === 0) {
        throw new Error(`${assessmentField}.${typedOutcome} must cite supporting evidence`);
      }
      if ((typedOutcome === 'cannot_evaluate' || typedOutcome === 'does_not_meet') && evidenceIds.length > 0) {
        throw new Error(`${assessmentField}.${typedOutcome} cannot cite supporting evidence`);
      }
      if (typedOutcome === 'does_not_meet' && conflictEvidenceIds.length === 0) {
        throw new Error(`${assessmentField}.does_not_meet requires affirmative conflict evidence`);
      }
      if (typedOutcome !== 'does_not_meet' && conflictEvidenceIds.length > 0) {
        throw new Error(`${assessmentField}.conflictEvidenceIds are reserved for does_not_meet`);
      }
      for (const evidenceId of [...evidenceIds, ...conflictEvidenceIds]) {
        if (!rationale.includes(evidenceId)) throw new Error(`${assessmentField}.rationale must cite ${evidenceId}`);
      }
      const mentionedIds = [...new Set(rationale.match(/\b[A-Z][A-Z0-9]*-\d{3}\b/g) || [])]
        .filter((candidateId) => evidencePrefixes.has(candidateId.split('-', 1)[0]));
      for (const evidenceId of mentionedIds) {
        if (![...evidenceIds, ...conflictEvidenceIds].includes(evidenceId)) {
          throw new Error(`${assessmentField}.rationale cites ${evidenceId} outside its evidence fields`);
        }
      }

      const administrativeClass = classifyAdministrativeEligibilityRequirement(candidate.text);
      if (administrativeClass === 'administrative_only') {
        throw new Error(`${assessmentField} administrative eligibility must be excluded before Agy evaluation`);
      }
      const professionalCredential = containsProfessionalCredential(candidate.text);
      if (professionalCredential && typedOutcome !== 'cannot_evaluate') {
        throw new Error(`${assessmentField}.unverified professional credential must be cannot_evaluate`);
      }
      const scoreNeutral = professionalCredential && typedOutcome === 'cannot_evaluate';
      if (typedOutcome === 'direct' || typedOutcome === 'partial') {
        const violation = requirementScopeViolation(
          candidate.text,
          typedOutcome === 'direct' ? 'direct' : 'adjacent',
          evidenceIds,
        );
        if (violation) throw new Error(`${assessmentField} ${violation}`);
      }
      return {
        requirementId,
        requirement: candidate.text,
        originalRequirement: candidate.originalText,
        classification: candidate.classification,
        sourceSection: candidate.sourceSection,
        outcome: typedOutcome,
        scoreNeutral,
        evidenceIds,
        conflictEvidenceIds,
        rationale,
      };
    });

    const aimFitReason = requiredString(record, 'aimFitReason', field, 4_000);
    const scopeNarrative = [aimFitReason, ...assessments.map((assessment) => assessment.rationale)].join('\n');
    if (
      /\b(?:held|formal|official|claimed|served as|worked as|title (?:was|of))\b.{0,80}\bchannel account manager\b/i.test(scopeNarrative)
      || /\b(?:six|6(?:\.0)?|6\.5)\+?\s+years?\b.{0,80}\b(?:as (?:a )?)?channel account manager\b/i.test(scopeNarrative)
    ) throw new Error(`${field}.narrative misstates Channel Account Manager as a held title or title tenure`);
    if (
      /\b(?:candidate|applicant|joseph|they|he|she|candidate['’]s\s+(?:background|experience)|their\s+(?:background|experience))\b.{0,140}\b(?:lacks?|lack|does not have|doesn't have|has no|is missing|cannot provide|cannot demonstrate|fails? to demonstrate|is not authorized|is ineligible)\b/i.test(scopeNarrative)
      || /\b(?:inventory|evidence)\b.{0,100}\b(?:does not mention|doesn't mention|contains no|is silent)\b.{0,100}\b(?:therefore|so|means)\b.{0,80}\b(?:candidate|applicant|joseph)\b/i.test(scopeNarrative)
    ) throw new Error(`${field}.narrative turns unknown or unrecorded evidence into a negative candidate fact`);

    const derived = deriveCriterionExperienceScore(assessments.map((assessment) => ({
      classification: assessment.classification,
      outcome: assessment.outcome,
      scoreNeutral: assessment.scoreNeutral,
    })));
    const requiredAssessments = assessments.filter((assessment) => assessment.classification === 'required' && !assessment.scoreNeutral);
    const evidenceIds = [...new Set(assessments.flatMap((assessment) => assessment.evidenceIds))];
    const qualificationBasis: QualificationSupport = requiredAssessments.some(
      (assessment) => assessment.outcome === 'cannot_evaluate' || assessment.outcome === 'does_not_meet',
    ) ? 'unsupported' : requiredAssessments.some((assessment) => assessment.outcome === 'partial') ? 'adjacent' : 'direct';
    const unmetMandatoryRequirements = requiredAssessments
      .filter((assessment) => assessment.outcome === 'does_not_meet')
      .map((assessment) => assessment.requirement);
    const mandatoryRequirementsMet = unmetMandatoryRequirements.length === 0;
    const gapText = requiredAssessments
      .filter((assessment) => assessment.outcome !== 'direct')
      .map((assessment) => `${assessment.requirement}: ${assessment.outcome}`)
      .join('; ');
    const experienceFitReason = `${derived.label} — deterministic criterion score ${derived.experienceFitScore}/100${derived.cap === null ? '' : ` (cap ${derived.cap})`}. Required ${requiredAssessments.length}; preferred ${assessments.filter((assessment) => assessment.classification === 'preferred' && !assessment.scoreNeutral).length}.${gapText ? ` ${gapText}.` : ''}`;
    const travelRange = extractTravelRange(packet);
    const compensation = extractExplicitCompensation(packet);

    return {
      id,
      aimFitScore: requiredScore(record, 'aimFitScore', field),
      experienceFitScore: derived.experienceFitScore,
      aimFitReason,
      experienceFitReason,
      travelScore: travelRange.maximumPercent,
      travelRange,
      compensation,
      evidenceIds,
      qualificationBasis,
      mandatoryRequirementAssessments: assessments,
      mandatoryRequirementsMet,
      unmetMandatoryRequirements,
      requiredDomain: null,
      candidateDomain: null,
      domainMatch: true,
      requiredYearsInDomain: null,
      candidateYearsInDomain: null,
    };
  });
  assertExpectedIds(scores.map((score) => score.id), expectedIds, 'standard result.standardScores');
  return scores;
}
