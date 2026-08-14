export type AimAnswerValue = 'yes' | 'no' | 'unsupported';
export type AimQuestionPhase = 'stage1' | 'stage2';
export type AimParserInput = 'stage1_fact' | 'score_fact' | 'compensation_fact' | 'travel_fact';
export type AimEvidenceSource = 'original_jd' | 'trusted_metadata';
export type AimMetadataField = 'company' | 'title' | 'location';

export type AimEvidenceCardinality = {
  minimumExactExcerpts: number;
  maximumExactExcerpts: number;
};

export type AimQuestion = {
  id: string;
  wording: string;
  privatePhase: AimQuestionPhase;
  allowedSources: AimEvidenceSource[];
  allowedMetadataFields: AimMetadataField[];
  evidenceRule: {
    yes: AimEvidenceCardinality;
    no: AimEvidenceCardinality;
    unsupported: AimEvidenceCardinality;
    maximumExcerptCodePoints: number;
    maximumTotalExcerptCodePoints: number;
  };
  parserInput: AimParserInput;
};

export type AimQuestionRegistry = {
  schemaVersion: 'aim-question-registry-v2';
  questionRegistryVersion: 'aim-question-registry-v2';
  questions: AimQuestion[];
};

export type AimPredicate = {
  op: string;
  ids?: string[];
  prefix?: string;
  conditions?: AimPredicate[];
  name?: string;
  value?: number;
};

export type AimPolicyTier = { points: number; predicate: AimPredicate };
export type AimPolicySubdimension = {
  cap: number;
  selection: string;
  tiers?: AimPolicyTier[];
  pointsByCount?: Record<string, number>;
  deduction?: boolean;
};

export type AimPreferenceTier = {
  code: string;
  points: number;
  predicate: AimPredicate;
};

export type AimPreferenceReachTier = {
  code: string;
  questionIds: string[];
  minimumPoints: number;
  maximumPoints: number;
};

export type AimPreferenceCap = {
  code: string;
  questionIds: string[];
  maximumPoints: number;
};

export type AimPreferenceComponentPolicy = {
  minimum: number;
  cap: number;
  selection: 'first_match' | 'first_match_with_caps' | 'travel_ladder';
  tiers?: AimPreferenceTier[];
  caps?: AimPreferenceCap[];
  absentPoints?: number;
  intensityScaleMaximum?: number;
  reachTiers?: AimPreferenceReachTier[];
};

export type AimPreferenceComponentName =
  | 'travel'
  | 'building'
  | 'autonomy'
  | 'channelPartnership'
  | 'farming'
  | 'industryInterest'
  | 'technicalPresalesDeduction'
  | 'huntingDeduction';

export type AimPreferenceScoringPolicy = {
  version: string;
  totalMinimum: number;
  totalMaximum: number;
  formula: AimPreferenceComponentName[];
  components: Record<AimPreferenceComponentName, AimPreferenceComponentPolicy>;
  crossQuestionClosures: unknown[];
  crossComponentReuseAllowlist: unknown[];
};

export type AimScoringPolicy = {
  schemaVersion: 'aim-policy-v2';
  policyVersion: 'aim-policy-v2';
  resultBuilderSemanticVersion: string;
  numericGateEnabled: false;
  administrativeEligibilityExcluded: true;
  identityHashKinds: Record<string, string>;
  localPolicy: Record<string, unknown>;
  stage1: Record<string, unknown>;
  stage2Projection: {
    version: string;
    crosswalkSchemaVersion: string;
    crosswalkHash: string;
    sourceQuestionCount: number;
    derivedQuestionCount: number;
    derivedOnlyQuestionIds: string[];
  };
  machineEvidenceGuards: Record<string, unknown>;
  compensation: Record<string, unknown>;
  travel: Record<string, unknown>;
  preferenceScoring: AimPreferenceScoringPolicy;
  supersededScoringSnapshot: Record<string, unknown>;
  bands: Array<{ minimum: number; maximum: number; code: string; label: string }>;
};

export type AimTrustedMetadata = {
  company: string;
  title: string;
  location: string | null;
};

export type AimEvidenceOccurrence = {
  startCodePoint: number;
  endCodePoint: number;
};

export type AimEvidenceEntry = {
  evidenceId: string;
  source: AimEvidenceSource;
  field: AimMetadataField | null;
  exactQuote: string;
  occurrences: AimEvidenceOccurrence[];
};

export type AimFactualAnswer = {
  questionId: string;
  answer: AimAnswerValue;
  evidenceIds: string[];
};

export type AimAttemptReceipt = {
  attemptOrdinal: number;
  effort: 'medium' | 'high';
  startedAt: string;
  completedAt: string;
  outcome: 'accepted' | 'invocation_failed' | 'output_invalid' | 'evidence_invalid';
  failureCategory: string | null;
  invocationReceipt: string;
};

export type AimPacketReceipt = {
  baseOrdinal: number;
  physicalOrdinal: number;
  packetPath: string;
  packetManifestHash: string;
  packetInputHash: string;
  model: string;
  attempts: AimAttemptReceipt[];
  acceptedAttempt: number | null;
  reusedFromPacketManifestHash: string | null;
};

export type AimFactualVector = {
  schemaVersion: 'career-dashboard-aim-factual-vector-v1';
  scope: 'stage1' | 'compensation_preflight' | 'complete';
  sourceJdHash: string;
  trustedMetadataHash: string;
  sourceIdentity: string;
  questionRegistryVersion: string;
  questionRegistryHash: string;
  promptContractVersion: string;
  promptContractHash: string;
  responseContractVersion: string;
  responseContractHash: string;
  runnerProtocolVersion: string;
  runnerProtocolHash: string;
  packetStrategyVersion: string;
  packetStrategyHash: string;
  canonicalizationVersion: string;
  anonymizationPolicyVersion: string;
  anonymizationPolicyHash: string;
  extractorSemanticVersion: string;
  extractionIdentity: string;
  answers: AimFactualAnswer[];
  evidenceCatalog: AimEvidenceEntry[];
  factualVectorHash: string;
  provenance: {
    disposition: 'fresh' | 'packet_cache_reuse' | 'dashboard_reuse';
    sourceExtractionId: string | null;
    packetPlanHash: string | null;
    packets: AimPacketReceipt[];
  };
};

export function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  }
  return value;
}
