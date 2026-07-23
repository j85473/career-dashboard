import {
  applyExperienceGuardrails,
  clampScore,
} from './scoringPolicy';

type JsonRecord = Record<string, unknown>;

export interface ExperienceScoreResult {
  id: string;
  requiredDomain: string;
  candidateDomain: string;
  domainMatch: boolean;
  requiredYearsInDomain: number | null;
  candidateYearsInDomain: number | null;
  experienceFitScore: number;
  experienceFitReason: string;
}

export interface ExperienceEvaluationResult {
  jobScores: ExperienceScoreResult[];
  omittedJobIds: string[];
  rejectedEntries: number;
}

export interface AimScoreResult {
  id: string;
  aimFitScore: number;
  aimFitReason: string;
  travelScore: number;
  atsSystem: string | null;
  compensation: string | null;
}

export interface AimEvaluationResult {
  updatedContextRules: string | null;
  processedContextJobIds: string[];
  contextUpdateRejected: boolean;
  jobScores: AimScoreResult[];
  omittedJobIds: string[];
  rejectedEntries: number;
}

export interface WildcardScoreResult {
  id: string;
  vibeFitScore: number;
  vibeFitReason: string;
  compensation: string | null;
}

export interface WildcardEvaluationResult {
  jobScores: WildcardScoreResult[];
  omittedJobIds: string[];
  rejectedEntries: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string, maxLength = 4_000): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`DeepSeek field ${key} must be a non-empty string`);
  }
  return value.trim().slice(0, maxLength);
}

function nullableString(record: JsonRecord, key: string, maxLength = 500): string | null {
  const value = record[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`DeepSeek field ${key} must be a string or null`);
  }
  return value.trim().slice(0, maxLength) || null;
}

function finiteNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`DeepSeek field ${key} must be a finite number`);
  }
  return value;
}

function nullableNonNegativeNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`DeepSeek field ${key} must be a non-negative number or null`);
  }
  return Math.round(value * 10) / 10;
}

function uniqueAllowedIds(value: unknown, allowedIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && allowedIds.has(id)))];
}

function validateContextRules(value: unknown, originalRules?: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('DeepSeek field updatedContextRules must be a string or null');
  }

  const rules = value.trim();
  if (!rules) throw new Error('DeepSeek context update cannot be empty');
  if (originalRules !== undefined && rules === originalRules.trim()) return rules || null;
  if (rules.length > 12_000) {
    throw new Error('DeepSeek context update exceeded 12,000 characters');
  }
  if (rules.length > 0 && !rules.split('\n').some((line) => /^\s*[-*]\s+/.test(line))) {
    throw new Error('DeepSeek context update must be a concise bulleted list');
  }
  if (/processed\s+(job|feedback)|conversation(?:al)?\s+(log|text)/i.test(rules)) {
    throw new Error('DeepSeek context update contains processing-log noise');
  }
  return rules || null;
}

export function validateExperienceEvaluation(
  value: unknown,
  submittedJobIds: ReadonlySet<string>,
): ExperienceEvaluationResult {
  if (!isRecord(value) || !Array.isArray(value.jobScores)) {
    throw new Error('DeepSeek response must contain a jobScores array');
  }

  const scores: ExperienceScoreResult[] = [];
  const seenIds = new Set<string>();
  let rejectedEntries = 0;

  for (const entry of value.jobScores) {
    try {
      if (!isRecord(entry)) throw new Error('Score entry must be an object');
      const id = requiredString(entry, 'id', 200);
      if (!submittedJobIds.has(id) || seenIds.has(id)) {
        throw new Error('Score entry ID was not submitted or was duplicated');
      }
      if (typeof entry.domain_match !== 'boolean') {
        throw new Error('DeepSeek field domain_match must be a boolean');
      }

      const requiredYearsInDomain = nullableNonNegativeNumber(entry, 'required_years_in_domain');
      const candidateYearsInDomain = nullableNonNegativeNumber(entry, 'candidate_years_in_domain');
      const experienceFitScore = applyExperienceGuardrails(
        finiteNumber(entry, 'experienceFitScore'),
        entry.domain_match,
        requiredYearsInDomain,
        candidateYearsInDomain,
      );

      scores.push({
        id,
        requiredDomain: requiredString(entry, 'required_domain', 500),
        candidateDomain: requiredString(entry, 'candidate_domain', 500),
        domainMatch: entry.domain_match,
        requiredYearsInDomain,
        candidateYearsInDomain,
        experienceFitScore,
        experienceFitReason: requiredString(entry, 'experienceFitReason'),
      });
      seenIds.add(id);
    } catch {
      rejectedEntries += 1;
    }
  }

  if (submittedJobIds.size > 0 && scores.length === 0) {
    throw new Error('DeepSeek response contained no valid submitted job scores');
  }

  return {
    jobScores: scores,
    omittedJobIds: [...submittedJobIds].filter((id) => !seenIds.has(id)),
    rejectedEntries,
  };
}

export function validateAimEvaluation(
  value: unknown,
  submittedJobIds: ReadonlySet<string>,
  submittedContextJobIds: ReadonlySet<string>,
  originalRules?: string,
): AimEvaluationResult {
  if (!isRecord(value) || !Array.isArray(value.jobScores)) {
    throw new Error('DeepSeek response must contain a jobScores array');
  }
  if (typeof value.updatedContextRules !== 'string') {
    throw new Error('DeepSeek response must contain updatedContextRules as a string');
  }
  if (!Array.isArray(value.processedContextJobIds)) {
    throw new Error('DeepSeek response must contain processedContextJobIds as an array');
  }

  const scores: AimScoreResult[] = [];
  const seenIds = new Set<string>();
  let rejectedEntries = 0;

  for (const entry of value.jobScores) {
    try {
      if (!isRecord(entry)) throw new Error('Score entry must be an object');
      const id = requiredString(entry, 'id', 200);
      if (!submittedJobIds.has(id) || seenIds.has(id)) {
        throw new Error('Score entry ID was not submitted or was duplicated');
      }

      const aimFitScore = clampScore(finiteNumber(entry, 'aimFitScore'));

      scores.push({
        id,
        aimFitScore,
        aimFitReason: requiredString(entry, 'aimFitReason'),
        travelScore: clampScore(finiteNumber(entry, 'travelScore')),
        atsSystem: nullableString(entry, 'atsSystem'),
        compensation: nullableString(entry, 'compensation'),
      });
      seenIds.add(id);
    } catch {
      rejectedEntries += 1;
    }
  }

  if (submittedJobIds.size > 0 && scores.length === 0) {
    throw new Error('DeepSeek response contained no valid submitted job scores');
  }

  let updatedContextRules: string | null;
  let contextUpdateRejected = false;
  try {
    updatedContextRules = validateContextRules(value.updatedContextRules, originalRules);
  } catch {
    updatedContextRules = originalRules?.trim() || null;
    contextUpdateRejected = true;
  }

  return {
    updatedContextRules,
    processedContextJobIds: contextUpdateRejected
      ? []
      : uniqueAllowedIds(value.processedContextJobIds, new Set(submittedContextJobIds)),
    contextUpdateRejected,
    jobScores: scores,
    omittedJobIds: [...submittedJobIds].filter((id) => !seenIds.has(id)),
    rejectedEntries,
  };
}

export function validateWildcardEvaluation(
  value: unknown,
  submittedJobIds: ReadonlySet<string>,
): WildcardEvaluationResult {
  if (!isRecord(value) || !Array.isArray(value.jobScores)) {
    throw new Error('DeepSeek wildcard response must contain a jobScores array');
  }

  const scores: WildcardScoreResult[] = [];
  const seenIds = new Set<string>();
  let rejectedEntries = 0;

  for (const entry of value.jobScores) {
    try {
      if (!isRecord(entry)) throw new Error('Score entry must be an object');
      const id = requiredString(entry, 'id', 200);
      if (!submittedJobIds.has(id) || seenIds.has(id)) {
        throw new Error('Score entry ID was not submitted or was duplicated');
      }

      scores.push({
        id,
        vibeFitScore: clampScore(finiteNumber(entry, 'vibeFitScore')),
        vibeFitReason: requiredString(entry, 'vibeFitReason'),
        compensation: nullableString(entry, 'compensation'),
      });
      seenIds.add(id);
    } catch {
      rejectedEntries += 1;
    }
  }

  if (submittedJobIds.size > 0 && scores.length === 0) {
    throw new Error('DeepSeek wildcard response contained no valid submitted job scores');
  }

  return {
    jobScores: scores,
    omittedJobIds: [...submittedJobIds].filter((id) => !seenIds.has(id)),
    rejectedEntries,
  };
}

export interface StandardScoreResult {
  id: string;
  requiredDomain: string;
  candidateDomain: string;
  domainMatch: boolean;
  requiredYearsInDomain: number | null;
  candidateYearsInDomain: number | null;
  aimFitScore: number;
  aimFitReason: string;
  experienceFitScore: number;
  experienceFitReason: string;
  travelScore: number;
  atsSystem: string | null;
  compensation: string | null;
}

export interface StandardEvaluationResult {
  updatedContextRules: string | null;
  processedContextJobIds: string[];
  contextUpdateRejected: boolean;
  jobScores: StandardScoreResult[];
  omittedJobIds: string[];
  rejectedEntries: number;
}

export function validateStandardEvaluation(
  value: unknown,
  submittedJobIds: ReadonlySet<string>,
  submittedContextJobIds: ReadonlySet<string>,
  originalRules?: string,
): StandardEvaluationResult {
  if (!isRecord(value) || !Array.isArray(value.jobScores)) {
    throw new Error('DeepSeek standard response must contain a jobScores array');
  }
  if (typeof value.updatedContextRules !== 'string') {
    throw new Error('DeepSeek standard response must contain updatedContextRules as a string');
  }
  if (!Array.isArray(value.processedContextJobIds)) {
    throw new Error('DeepSeek standard response must contain processedContextJobIds as an array');
  }

  const scores: StandardScoreResult[] = [];
  const seenIds = new Set<string>();
  let rejectedEntries = 0;

  for (const entry of value.jobScores) {
    try {
      if (!isRecord(entry)) throw new Error('Score entry must be an object');
      const id = requiredString(entry, 'id', 200);
      if (!submittedJobIds.has(id) || seenIds.has(id)) {
        throw new Error('Score entry ID was not submitted or was duplicated');
      }
      if (typeof entry.domain_match !== 'boolean') {
        throw new Error('DeepSeek field domain_match must be a boolean');
      }

      const aimFitScore = clampScore(finiteNumber(entry, 'aimFitScore'));
      const requiredYearsInDomain = nullableNonNegativeNumber(entry, 'required_years_in_domain');
      const candidateYearsInDomain = nullableNonNegativeNumber(entry, 'candidate_years_in_domain');
      const experienceFitScore = applyExperienceGuardrails(
        finiteNumber(entry, 'experienceFitScore'),
        entry.domain_match,
        requiredYearsInDomain,
        candidateYearsInDomain,
      );

      scores.push({
        id,
        requiredDomain: requiredString(entry, 'required_domain', 500),
        candidateDomain: requiredString(entry, 'candidate_domain', 500),
        domainMatch: entry.domain_match,
        requiredYearsInDomain,
        candidateYearsInDomain,
        aimFitScore,
        aimFitReason: requiredString(entry, 'aimFitReason'),
        experienceFitScore,
        experienceFitReason: requiredString(entry, 'experienceFitReason'),
        travelScore: clampScore(finiteNumber(entry, 'travelScore')),
        atsSystem: nullableString(entry, 'atsSystem'),
        compensation: nullableString(entry, 'compensation'),
      });
      seenIds.add(id);
    } catch {
      rejectedEntries += 1;
    }
  }

  if (submittedJobIds.size > 0 && scores.length === 0) {
    throw new Error('DeepSeek standard response contained no valid submitted job scores');
  }

  let updatedContextRules: string | null;
  let contextUpdateRejected = false;
  try {
    updatedContextRules = validateContextRules(value.updatedContextRules, originalRules);
  } catch {
    updatedContextRules = originalRules?.trim() || null;
    contextUpdateRejected = true;
  }

  return {
    updatedContextRules,
    processedContextJobIds: contextUpdateRejected
      ? []
      : uniqueAllowedIds(value.processedContextJobIds, new Set(submittedContextJobIds)),
    contextUpdateRejected,
    jobScores: scores,
    omittedJobIds: [...submittedJobIds].filter((id) => !seenIds.has(id)),
    rejectedEntries,
  };
}
