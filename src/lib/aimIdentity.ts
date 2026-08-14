import { canonicalJsonSha256, normalizeScoringText, normalizedTextSha256 } from './scoringCanonicalJson';
import type {
  AimEvidenceEntry,
  AimEvidenceOccurrence,
  AimFactualAnswer,
  AimFactualVector,
  AimTrustedMetadata,
} from './aimV2Types';

export const AIM_CANONICALIZATION_VERSION = 'aim-text-canonicalization-v1';

export function normalizeAimSource(value: string): string {
  return normalizeScoringText(value);
}

export function normalizeAimTrustedMetadata(value: AimTrustedMetadata): AimTrustedMetadata {
  const company = normalizeScoringText(value.company);
  const title = normalizeScoringText(value.title);
  const location = value.location === null ? null : normalizeScoringText(value.location);
  if (!/\S/u.test(company)) throw new Error('Aim trusted company must contain a non-whitespace code point');
  if (!/\S/u.test(title)) throw new Error('Aim trusted title must contain a non-whitespace code point');
  return { company, title, location };
}

export function aimSourceJdHash(canonicalOriginalJd: string): string {
  return normalizedTextSha256(canonicalOriginalJd);
}

export function aimTrustedMetadataHash(metadata: AimTrustedMetadata): string {
  const normalized = normalizeAimTrustedMetadata(metadata);
  return canonicalJsonSha256({ kind: 'aim_trusted_metadata_v1', ...normalized });
}

export function aimSourceIdentity(sourceJdHash: string, trustedMetadataHash: string): string {
  return canonicalJsonSha256({ kind: 'aim_source_identity_v1', sourceJdHash, trustedMetadataHash });
}

export type AimExtractionIdentityInput = {
  sourceIdentity: string;
  questionRegistryVersion: string;
  questionRegistryHash: string;
  promptContractVersion: string;
  promptContractHash: string;
  responseContractVersion: string;
  responseContractHash: string;
  packetStrategyVersion: string;
  packetStrategyHash: string;
  canonicalizationVersion: string;
  anonymizationPolicyVersion: string;
  anonymizationPolicyHash: string;
  extractorSemanticVersion: string;
};

export function aimExtractionIdentity(input: AimExtractionIdentityInput): string {
  return canonicalJsonSha256({ kind: 'aim_extraction_identity_v1', ...input });
}

export function aimModelVisibleMetadataProjectionHash(fields: Partial<AimTrustedMetadata>): string {
  return canonicalJsonSha256({ kind: 'aim_model_metadata_projection_v1', fields });
}

export function aimBaseMembershipHash(packetStrategyHash: string, baseOrdinal: number, questionIds: readonly string[]): string {
  return canonicalJsonSha256({
    kind: 'aim_base_membership_v1',
    packetStrategyHash,
    baseOrdinal,
    sortedQuestionIds: [...questionIds].sort(compareCodePointStrings),
  });
}

export function aimPacketManifestHash(input: {
  baseOrdinal: number;
  physicalOrdinal: number;
  orderedQuestionIds: readonly string[];
  modelVisibleMetadataProjectionHash: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_packet_manifest_v1', ...input, orderedQuestionIds: [...input.orderedQuestionIds] });
}

export function aimPacketPlanHash(orderedPacketManifestHashes: readonly string[]): string {
  return canonicalJsonSha256({ kind: 'aim_packet_plan_v1', orderedPacketManifestHashes: [...orderedPacketManifestHashes] });
}

export function aimPacketCheckpointKey(input: {
  extractionIdentity: string;
  packetPlanHash: string;
  packetManifestHash: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_packet_checkpoint_v1', ...input });
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

export function normalizeAimEvidenceOccurrences(occurrences: readonly AimEvidenceOccurrence[]): AimEvidenceOccurrence[] {
  const sorted = occurrences.map((entry) => ({ ...entry })).sort((left, right) => (
    left.startCodePoint - right.startCodePoint || left.endCodePoint - right.endCodePoint
  ));
  return sorted.filter((entry, index) => index === 0
    || entry.startCodePoint !== sorted[index - 1].startCodePoint
    || entry.endCodePoint !== sorted[index - 1].endCodePoint);
}

export function aimEvidenceId(input: Omit<AimEvidenceEntry, 'evidenceId'>): string {
  return canonicalJsonSha256({
    kind: 'aim_evidence_v1',
    source: input.source,
    field: input.field,
    exactQuote: input.exactQuote,
    orderedOccurrences: normalizeAimEvidenceOccurrences(input.occurrences),
  });
}

const METADATA_FIELD_ORDER: Readonly<Record<string, number>> = { company: 0, title: 1, location: 2 };

export function compareAimEvidenceEntries(left: AimEvidenceEntry, right: AimEvidenceEntry): number {
  if (left.source !== right.source) return left.source === 'original_jd' ? -1 : 1;
  if (left.source === 'original_jd') {
    const leftFirst = left.occurrences[0];
    const rightFirst = right.occurrences[0];
    const byOccurrence = leftFirst.startCodePoint - rightFirst.startCodePoint || leftFirst.endCodePoint - rightFirst.endCodePoint;
    if (byOccurrence !== 0) return byOccurrence;
  } else {
    const byField = (METADATA_FIELD_ORDER[left.field ?? ''] ?? 99) - (METADATA_FIELD_ORDER[right.field ?? ''] ?? 99);
    if (byField !== 0) return byField;
  }
  const byQuote = compareCodePointStrings(left.exactQuote, right.exactQuote);
  return byQuote || compareCodePointStrings(left.evidenceId, right.evidenceId);
}

export function sourceOrderAimEvidenceCatalog(catalog: readonly AimEvidenceEntry[]): AimEvidenceEntry[] {
  return catalog.map((entry) => ({
    ...entry,
    occurrences: normalizeAimEvidenceOccurrences(entry.occurrences),
  })).sort(compareAimEvidenceEntries);
}

export type AimFactualVectorHashInput = Pick<AimFactualVector,
  'scope' | 'sourceIdentity' | 'trustedMetadataHash' | 'questionRegistryHash'
  | 'promptContractHash' | 'responseContractHash' | 'packetStrategyHash'
  | 'canonicalizationVersion' | 'anonymizationPolicyVersion' | 'anonymizationPolicyHash'
  | 'extractorSemanticVersion'> & {
    answers: readonly AimFactualAnswer[];
    evidenceCatalog: readonly AimEvidenceEntry[];
  };

export function aimFactualVectorHash(input: AimFactualVectorHashInput): string {
  return canonicalJsonSha256({
    kind: 'aim_factual_vector_v1',
    scope: input.scope,
    sourceIdentity: input.sourceIdentity,
    trustedMetadataHash: input.trustedMetadataHash,
    questionRegistryHash: input.questionRegistryHash,
    promptContractHash: input.promptContractHash,
    responseContractHash: input.responseContractHash,
    packetStrategyHash: input.packetStrategyHash,
    canonicalizationVersion: input.canonicalizationVersion,
    anonymizationPolicyVersion: input.anonymizationPolicyVersion,
    anonymizationPolicyHash: input.anonymizationPolicyHash,
    extractorSemanticVersion: input.extractorSemanticVersion,
    orderedAnswers: input.answers,
    sourceOrderedEvidenceCatalog: input.evidenceCatalog,
  });
}

export function aimLocalPolicyFactsHash(input: {
  sourceIdentity: string;
  trustedMetadataHash: string;
  orderedLocalTriggerCodes: readonly string[];
}): string {
  return canonicalJsonSha256({ kind: 'aim_local_policy_facts_v1', ...input, orderedLocalTriggerCodes: [...input.orderedLocalTriggerCodes] });
}

export function aimLocalPolicyScoringIdentity(input: {
  localPolicyFactsHash: string;
  scoringPolicyVersion: string;
  scoringPolicyHash: string;
  resultBuilderSemanticVersion: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_local_policy_scoring_identity_v1', ...input });
}

export function aimScoringIdentity(input: {
  factualVectorHash: string;
  trustedMetadataHash: string;
  scoringPolicyVersion: string;
  scoringPolicyHash: string;
  resultBuilderSemanticVersion: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_scoring_identity_v1', ...input });
}

export function aimSemanticResultHash(input: {
  resultVariant: string;
  extractionIdentity: string | null;
  scoringIdentity: string;
  deterministicResult: unknown;
}): string {
  return canonicalJsonSha256({ kind: 'aim_semantic_result_v1', ...input });
}

export function aimBatchItemInputHash(input: {
  protocolVersion: string;
  exportSchemaVersion: string;
  sourceIdentity: string;
  extractionIdentity: string;
  scoringPolicyHash: string;
  runnerProtocolHash: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_batch_item_input_v2', stage: 'aim', ...input });
}

export function aimResultItemHash(itemWithoutResultHash: unknown): string {
  return canonicalJsonSha256({ kind: 'aim_result_item_v2', itemWithoutResultHash });
}

export function aimResultEnvelopeHash(envelopeWithoutResultHash: unknown): string {
  return canonicalJsonSha256({ kind: 'aim_result_envelope_v2', envelopeWithoutResultHash });
}

export function aimExtractionFailureResolutionIdentity(input: {
  inputHash: string;
  extractionIdentity: string;
  runnerProtocolHash: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_extraction_failure_resolution_v1', ...input });
}

export function aimBuilderFailureResolutionIdentity(input: {
  inputHash: string;
  extractionIdentity: string;
  scoringPolicyHash: string;
  resultBuilderSemanticVersion: string;
  runnerProtocolHash: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_builder_failure_resolution_v1', ...input });
}

export function aimFailureRetrySeriesKey(input: {
  jobId: string;
  failureResolutionIdentity: string;
  failureCode: string;
}): string {
  return canonicalJsonSha256({ kind: 'aim_failure_retry_series_v1', ...input });
}

export function aimFailureSuppressionKey(input: { retrySeriesKey: string; permanence: string }): string {
  return canonicalJsonSha256({ kind: 'aim_safe_failure_suppression_v1', ...input });
}
