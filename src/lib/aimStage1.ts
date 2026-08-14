import { hasMinneapolisMetroOption, type RequiredWorkBaseCompatibility } from './jobLocationPolicy';
import type { AimEvidenceEntry, AimFactualVector, AimScoringPolicy, AimTrustedMetadata } from './aimV2Types';

export type AimLocalPolicyResult = {
  triggerCodes: string[];
  decision: 'killed_local_policy' | 'continue_to_stage1';
};

export type AimStage1Result = {
  triggerQuestionIds: string[];
  locationState: RequiredWorkBaseCompatibility | null;
  insuranceState: 'local_agency' | 'not_local_or_not_agency' | 'unknown' | null;
  decision: 'killed_by_factual_screen' | 'continue_to_compensation';
};

export function isCurrentAimExperienceAnchor(
  extraction: { scope: string; sourceJdHash: string; staleAt: Date | null } | null | undefined,
  sourceJdHash: string,
): extraction is { scope: string; sourceJdHash: string; staleAt: null } {
  return Boolean(
    extraction
    && extraction.staleAt === null
    && extraction.scope === 'stage1'
    && extraction.sourceJdHash === sourceJdHash,
  );
}

export function normalizeDirectEmployerName(value: string): string {
  const removable = new Set(['incorporated', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'company']);
  return value
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word && !removable.has(word))
    .join(' ');
}

export function evaluateAimLocalPolicy(metadata: AimTrustedMetadata, policy: AimScoringPolicy): AimLocalPolicyResult {
  const localPolicy = policy.localPolicy as {
    triggerOrder: string[];
    triggers: Array<{ code: string; directEmploymentOnly: boolean; normalizedAliases: string[] }>;
  };
  const normalizedCompany = normalizeDirectEmployerName(metadata.company);
  const matching = new Set(localPolicy.triggers.filter((trigger) => (
    trigger.directEmploymentOnly
    && trigger.normalizedAliases.map(normalizeDirectEmployerName).includes(normalizedCompany)
  )).map((trigger) => trigger.code));
  const triggerCodes = localPolicy.triggerOrder.filter((code) => matching.has(code));
  return { triggerCodes, decision: triggerCodes.length > 0 ? 'killed_local_policy' : 'continue_to_stage1' };
}

function evidenceById(vector: AimFactualVector): Map<string, AimEvidenceEntry> {
  return new Map(vector.evidenceCatalog.map((entry) => [entry.evidenceId, entry]));
}

function answerEvidence(vector: AimFactualVector, questionId: string, catalog: Map<string, AimEvidenceEntry>): AimEvidenceEntry[] {
  const answer = vector.answers.find((entry) => entry.questionId === questionId);
  return answer?.evidenceIds.map((evidenceId) => catalog.get(evidenceId)!).filter(Boolean) ?? [];
}

function isYes(vector: AimFactualVector, questionId: string): boolean {
  return vector.answers.find((entry) => entry.questionId === questionId)?.answer === 'yes';
}

export function classifyLocalInsuranceAgency(
  evidence: readonly AimEvidenceEntry[],
  metadata: AimTrustedMetadata,
  policy: AimScoringPolicy,
): 'local_agency' | 'not_local_or_not_agency' | 'unknown' {
  const insurancePolicy = (policy.stage1 as {
    localInsuranceAgencyPolicy: {
      directEmployerLexemes: string[];
      localGeographyLexemes: string[];
      exactEmployerOfficeAliases: string[];
      insufficientEmployerTypes: string[];
    };
  }).localInsuranceAgencyPolicy;
  const text = evidence.map((entry) => entry.exactQuote).join('\n').toLocaleLowerCase('en-US');
  const includes = (values: readonly string[]): boolean => values.some((value) => text.includes(value.toLocaleLowerCase('en-US')));
  const agency = includes(insurancePolicy.directEmployerLexemes);
  if (!agency) {
    return includes(insurancePolicy.insufficientEmployerTypes) ? 'not_local_or_not_agency' : 'unknown';
  }
  const explicitLocal = includes(insurancePolicy.localGeographyLexemes) || hasMinneapolisMetroOption(text);
  if (explicitLocal) return 'local_agency';
  const normalizedCompany = normalizeDirectEmployerName(metadata.company);
  const exactAlias = insurancePolicy.exactEmployerOfficeAliases.map(normalizeDirectEmployerName).includes(normalizedCompany);
  if (exactAlias && metadata.location !== null && hasMinneapolisMetroOption(metadata.location)) return 'local_agency';
  if (/\b(?:national|nationwide|multi-state|global)\b/u.test(text)) return 'not_local_or_not_agency';
  return 'unknown';
}

export function evaluateAimStage1(
  vector: AimFactualVector,
  metadata: AimTrustedMetadata,
  policy: AimScoringPolicy,
): AimStage1Result {
  if (vector.scope !== 'stage1' && vector.scope !== 'compensation_preflight' && vector.scope !== 'complete') {
    throw new Error('Aim Stage 1 requires a factual vector containing Stage 1');
  }
  const stage1Policy = policy.stage1 as {
    triggerOrder: string[];
    unconditionalYesKills: string[];
  };
  const catalog = evidenceById(vector);
  const triggers = new Set<string>();
  for (const questionId of stage1Policy.unconditionalYesKills) if (isYes(vector, questionId)) triggers.add(questionId);

  // S1.Q03 asks the complete MSP-residence proposition directly. A validated
  // yes dismisses; no and unsupported continue. Do not reinterpret the answer
  // through a second generic location parser.
  const locationState: RequiredWorkBaseCompatibility | null = isYes(vector, 'S1.Q03') ? 'incompatible' : null;

  let insuranceState: AimStage1Result['insuranceState'] = null;
  if (isYes(vector, 'S1.Q06')) {
    insuranceState = classifyLocalInsuranceAgency(answerEvidence(vector, 'S1.Q06', catalog), metadata, policy);
    if (insuranceState === 'local_agency') triggers.add('S1.Q06');
  }

  const triggerQuestionIds = stage1Policy.triggerOrder.filter((questionId) => triggers.has(questionId));
  return {
    triggerQuestionIds,
    locationState,
    insuranceState,
    decision: triggerQuestionIds.length > 0 ? 'killed_by_factual_screen' : 'continue_to_compensation',
  };
}
