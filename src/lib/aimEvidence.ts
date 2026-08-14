import vectorSchema from '../../data/scoring/schemas/aim-factual-vector-v1.schema.json';

import { canonicalJson, codePointLength, normalizeScoringText } from './scoringCanonicalJson';
import {
  aimEvidenceId,
  aimExtractionIdentity,
  aimFactualVectorHash,
  aimSourceIdentity,
  aimSourceJdHash,
  aimTrustedMetadataHash,
  compareAimEvidenceEntries,
  normalizeAimEvidenceOccurrences,
  sourceOrderAimEvidenceCatalog,
} from './aimIdentity';
import { validateJsonSchema, type JsonSchema } from './scoringJsonSchema';
import type {
  AimEvidenceEntry,
  AimEvidenceOccurrence,
  AimFactualVector,
  AimQuestion,
  AimQuestionRegistry,
  AimScoringPolicy,
  AimTrustedMetadata,
} from './aimV2Types';

function buildUtf16ToCodePointMap(source: string): Map<number, number> {
  const map = new Map<number, number>();
  let utf16 = 0;
  let codePoint = 0;
  map.set(0, 0);
  for (const character of source) {
    utf16 += character.length;
    codePoint += 1;
    map.set(utf16, codePoint);
  }
  return map;
}

export function allExactCodePointOccurrences(source: string, exactQuote: string): AimEvidenceOccurrence[] {
  if (exactQuote.length === 0) throw new Error('Aim evidence quote must be nonempty');
  const boundaryMap = buildUtf16ToCodePointMap(source);
  const occurrences: AimEvidenceOccurrence[] = [];
  let fromIndex = 0;
  while (fromIndex <= source.length - exactQuote.length) {
    const startUtf16 = source.indexOf(exactQuote, fromIndex);
    if (startUtf16 < 0) break;
    const endUtf16 = startUtf16 + exactQuote.length;
    const startCodePoint = boundaryMap.get(startUtf16);
    const endCodePoint = boundaryMap.get(endUtf16);
    if (startCodePoint !== undefined && endCodePoint !== undefined) occurrences.push({ startCodePoint, endCodePoint });
    fromIndex = startUtf16 + 1;
  }
  return occurrences;
}

function sourceForEvidence(
  entry: AimEvidenceEntry,
  canonicalOriginalJd: string,
  trustedMetadata: AimTrustedMetadata,
): string {
  if (entry.source === 'original_jd') {
    if (entry.field !== null) throw new Error(`${entry.evidenceId} original-JD evidence must have null field`);
    return canonicalOriginalJd;
  }
  if (entry.field === null) throw new Error(`${entry.evidenceId} trusted-metadata evidence requires a field`);
  const value = trustedMetadata[entry.field];
  if (value === null) throw new Error(`${entry.evidenceId} references null trusted metadata`);
  return value;
}

function assertEvidenceEntry(
  entry: AimEvidenceEntry,
  canonicalOriginalJd: string,
  trustedMetadata: AimTrustedMetadata,
): void {
  if (entry.exactQuote !== normalizeScoringText(entry.exactQuote)) throw new Error(`${entry.evidenceId} evidence quote is not canonical`);
  if (codePointLength(entry.exactQuote) > 320) throw new Error(`${entry.evidenceId} evidence quote exceeds 320 code points`);
  const source = sourceForEvidence(entry, canonicalOriginalJd, trustedMetadata);
  const actualOccurrences = allExactCodePointOccurrences(source, entry.exactQuote);
  if (actualOccurrences.length === 0) throw new Error(`${entry.evidenceId} evidence quote is not an exact source substring`);
  if (canonicalJson(actualOccurrences) !== canonicalJson(normalizeAimEvidenceOccurrences(entry.occurrences))) {
    throw new Error(`${entry.evidenceId} does not bind every exact occurrence`);
  }
  const expectedId = aimEvidenceId({
    source: entry.source,
    field: entry.field,
    exactQuote: entry.exactQuote,
    occurrences: actualOccurrences,
  });
  if (entry.evidenceId !== expectedId) throw new Error(`${entry.evidenceId} evidence ID mismatch`);
}

function scopeQuestions(
  vector: AimFactualVector,
  registry: AimQuestionRegistry,
  expectedQuestionIds?: readonly string[],
): AimQuestion[] {
  if (expectedQuestionIds) {
    const expected = new Set(expectedQuestionIds);
    if (expected.size !== expectedQuestionIds.length) throw new Error('expected Aim scope contains duplicate question IDs');
    return registry.questions.filter((question) => expected.has(question.id));
  }
  if (vector.scope === 'stage1') return registry.questions.filter((question) => question.privatePhase === 'stage1');
  if (vector.scope === 'complete') return registry.questions;
  const required = registry.questions.filter((question) => question.privatePhase === 'stage1' || question.parserInput === 'compensation_fact');
  if (vector.answers.length < required.length) {
    throw new Error('compensation-preflight vector must contain Stage 1 plus every compensation fact');
  }
  const answerIds = new Set(vector.answers.map((answer) => answer.questionId));
  for (const question of required) if (!answerIds.has(question.id)) throw new Error(`compensation-preflight vector is missing ${question.id}`);
  return registry.questions.filter((question) => answerIds.has(question.id));
}

function lowerEvidenceText(entries: readonly AimEvidenceEntry[]): string[] {
  return entries.map((entry) => entry.exactQuote.toLocaleLowerCase('en-US'));
}

function hasAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value.toLocaleLowerCase('en-US')));
}

function assertMachineGuard(question: AimQuestion, entries: readonly AimEvidenceEntry[], policy: AimScoringPolicy): void {
  if (entries.length === 0) return;
  const guards = policy.machineEvidenceGuards as {
    primaryOrMajorityPhrases?: string[];
    governingHeadingPhrases?: string[];
    accountabilityLexemes?: string[];
    finalAuthorityLexemes?: string[];
    questionGuards?: Record<string, { kind?: string; [key: string]: unknown }>;
  };
  const guard = guards.questionGuards?.[question.id];
  if (!guard?.kind) return;
  const texts = lowerEvidenceText(entries);
  const combined = texts.join('\n');
  const originalCombined = entries.map((entry) => entry.exactQuote).join('\n');
  const strings = (key: string): string[] => Array.isArray(guard[key]) ? guard[key].filter((value): value is string => typeof value === 'string') : [];

  if (guard.kind === 'primary_activity_same_scope') {
    const primary = guards.primaryOrMajorityPhrases ?? [];
    const activities = strings('activityLexemes');
    const sameExcerpt = texts.some((text) => hasAny(text, primary) && hasAny(text, activities));
    const headingThenActivity = entries.length === 2
      && hasAny(texts[0], guards.governingHeadingPhrases ?? [])
      && hasAny(texts[1], activities)
      && entries[0].source === entries[1].source
      && entries[0].field === entries[1].field
      && entries[0].occurrences[0].endCodePoint <= entries[1].occurrences[0].startCodePoint;
    if (!sameExcerpt && !headingThenActivity) throw new Error(`${question.id} lacks a primary/majority machine guard`);
  } else if (guard.kind === 'named_required_location_same_scope') {
    if (!hasAny(combined, strings('requirementLexemes'))) throw new Error(`${question.id} lacks a required-location machine guard`);
    const namedLocation = /\b(?:in|to|at|within)\s+(?:the\s+)?(?:[A-Z][\p{L}.-]+(?:[ -]+[A-Z][\p{L}.-]+){0,3}|[A-Z]{2})(?:\b|,)/u.test(originalCombined)
      || /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|united states|canada)\b/iu.test(originalCombined);
    if (!namedLocation) throw new Error(`${question.id} lacks a named location`);
  } else if (guard.kind === 'closed_direct_employer_lexeme') {
    const lexemes = strings('employerLexemes').length > 0
      ? strings('employerLexemes')
      : ((policy.stage1 as { localInsuranceAgencyPolicy?: { directEmployerLexemes?: string[] } })
        .localInsuranceAgencyPolicy?.directEmployerLexemes ?? []);
    if (lexemes.length > 0 && !hasAny(combined, lexemes)) throw new Error(`${question.id} lacks a direct-employer policy lexeme`);
  } else if (guard.kind === 'same_scope_lexeme') {
    if (!texts.some((text) => hasAny(text, strings('requiredLexemes')))) throw new Error(`${question.id} lacks its responsibility machine guard`);
  } else if (guard.kind === 'partnership_management_same_scope') {
    if (!texts.some((text) => hasAny(text, strings('actionLexemes')) && hasAny(text, strings('partnerLexemes')))) {
      throw new Error(`${question.id} lacks partner-management responsibility`);
    }
  } else if (guard.kind === 'linked_cross_lifecycle') {
    const pre = strings('preSaleLexemes');
    const post = strings('postSaleLexemes');
    if (!texts.some((text) => hasAny(text, pre) && hasAny(text, post)) && !(hasAny(combined, pre) && hasAny(combined, post))) {
      throw new Error(`${question.id} lacks both lifecycle sides`);
    }
  } else if (guard.kind === 'accountability_same_scope') {
    if (!texts.some((text) => hasAny(text, guards.accountabilityLexemes ?? []))) throw new Error(`${question.id} lacks accountability language`);
  } else if (guard.kind === 'metric_reporting_same_scope') {
    if (!texts.some((text) => /\b(?:report|reporting|performance)\b/u.test(text)
      && /\b(?:defined\s+metrics?|metrics?|kpis?|targets?|quotas?|revenue|pipeline|conversion|retention|renewals?)\b/u.test(text))) {
      throw new Error(`${question.id} lacks metric-reporting language tied to a defined metric`);
    }
  } else if (guard.kind === 'prescribed_or_mature_with_limited_change') {
    if (!/\b(?:prescribed|standardized|mature|established)\b/u.test(combined) || !/\b(?:limited|little|no)\b.{0,80}\b(?:authority|change|modify|redesign)\b/u.test(combined)) {
      throw new Error(`${question.id} lacks both process maturity and limited-change authority`);
    }
  } else if (guard.kind === 'final_or_approval_authority') {
    if (!hasAny(combined, guards.finalAuthorityLexemes ?? [])) throw new Error(`${question.id} lacks final authority language`);
  } else if (guard.kind === 'parsed_compensation_value_inside_evidence') {
    if (!/(?<![\p{L}\p{N}.])(?:USD\s*|US\$\s*|\$\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*[kK]?(?![\p{L}\p{N}])/iu.test(originalCombined)) {
      throw new Error(`${question.id} lacks a compensation value`);
    }
  } else if (guard.kind === 'parsed_travel_value_inside_evidence') {
    if (!/\b\d{1,3}\s*(?:%|percent)(?!\p{L})/iu.test(originalCombined)) {
      throw new Error(`${question.id} lacks a travel percentage`);
    }
  } else if (guard.kind === 'travel_qualitative_same_scope') {
    const terms = Object.keys((policy.travel as { qualitativeLexemes?: Record<string, number> }).qualitativeLexemes ?? {});
    if (!/\btravel(?:s|ing|led|ling)?\b/u.test(combined) || !hasAny(combined, terms)) {
      throw new Error(`${question.id} lacks travel plus a configured qualitative term`);
    }
  } else if (guard.kind === 'travel_named_scope_same_scope') {
    const named: Readonly<Record<string, readonly string[]>> = {
      'S2.TR.Q05': ['local', 'territory'],
      'S2.TR.Q06': ['regional', 'multistate', 'multi-state'],
      'S2.TR.Q07': ['national', 'united states', 'u.s.'],
      'S2.TR.Q08': ['canada', 'north america', 'north american'],
      'S2.TR.Q09': ['international', 'global'],
      'S2.TR.Q10': ['recurring', 'customer', 'partner', 'in-person', 'in person'],
      'S2.TR.Q11': ['customer-site', 'partner-site', 'external meeting', 'presentation', 'business review', 'implementation', 'deployment', 'training', 'technical'],
      'S2.TR.Q12': ['field-based', 'remote', 'home-based', 'overnight', 'air travel', 'driving'],
      'S2.TR.Q13': ['conference', 'trade show', 'event', 'internal meeting', 'team gathering'],
    };
    const namedScope = question.id === 'S2.TR.Q10'
      ? hasAny(combined, ['recurring', 'regular']) && hasAny(combined, ['customer', 'partner'])
      : hasAny(combined, named[question.id] ?? []);
    if (!/\btravel(?:s|ing|led|ling)?\b/u.test(combined) || !namedScope) {
      throw new Error(`${question.id} lacks travel plus its named scope`);
    }
  } else if (guard.kind === 'exact_geographic_modifier') {
    const modifiers: Readonly<Record<string, readonly string[]>> = {
      'S2.SC.Q04': ['multi-country', 'international', 'multi-region'],
      'S2.SC.Q05': ['global'],
      'S2.SC.Q08': ['global'],
      'S2.LI.Q13': ['multiple geographic regions', 'multi-region', 'across regions'],
      'S2.LI.Q14': ['global'],
    };
    if (!hasAny(combined, modifiers[question.id] ?? [])) throw new Error(`${question.id} lacks its exact geographic modifier`);
  } else {
    throw new Error(`${question.id} uses unsupported machine guard ${String(guard.kind)}`);
  }
}

export type ValidateAimFactualVectorInput = {
  vector: unknown;
  canonicalOriginalJd: string;
  trustedMetadata: AimTrustedMetadata;
  registry: AimQuestionRegistry;
  policy?: AimScoringPolicy;
  expectedQuestionIds?: readonly string[];
};

export function validateAimFactualVector(input: ValidateAimFactualVectorInput): AimFactualVector {
  const vectorValue = structuredClone(input.vector);
  validateJsonSchema(vectorValue, vectorSchema as JsonSchema);
  const vector = vectorValue as AimFactualVector;
  const canonicalOriginalJd = normalizeScoringText(input.canonicalOriginalJd);
  if (canonicalOriginalJd !== input.canonicalOriginalJd) throw new Error('Aim source must already be NFC/LF canonical');
  const trustedMetadata = {
    company: normalizeScoringText(input.trustedMetadata.company),
    title: normalizeScoringText(input.trustedMetadata.title),
    location: input.trustedMetadata.location === null ? null : normalizeScoringText(input.trustedMetadata.location),
  };
  if (canonicalJson(trustedMetadata) !== canonicalJson(input.trustedMetadata)) throw new Error('Aim trusted metadata must already be canonical');

  const sourceJdHash = aimSourceJdHash(canonicalOriginalJd);
  const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
  const sourceIdentity = aimSourceIdentity(sourceJdHash, trustedMetadataHash);
  if (vector.sourceJdHash !== sourceJdHash) throw new Error('Aim factual vector source JD hash mismatch');
  if (vector.trustedMetadataHash !== trustedMetadataHash) throw new Error('Aim factual vector trusted metadata hash mismatch');
  if (vector.sourceIdentity !== sourceIdentity) throw new Error('Aim factual vector source identity mismatch');
  const extractionIdentity = aimExtractionIdentity({
    sourceIdentity,
    questionRegistryVersion: vector.questionRegistryVersion,
    questionRegistryHash: vector.questionRegistryHash,
    promptContractVersion: vector.promptContractVersion,
    promptContractHash: vector.promptContractHash,
    responseContractVersion: vector.responseContractVersion,
    responseContractHash: vector.responseContractHash,
    packetStrategyVersion: vector.packetStrategyVersion,
    packetStrategyHash: vector.packetStrategyHash,
    canonicalizationVersion: vector.canonicalizationVersion,
    anonymizationPolicyVersion: vector.anonymizationPolicyVersion,
    anonymizationPolicyHash: vector.anonymizationPolicyHash,
    extractorSemanticVersion: vector.extractorSemanticVersion,
  });
  if (vector.extractionIdentity !== extractionIdentity) throw new Error('Aim factual vector extraction identity mismatch');

  const expectedQuestions = scopeQuestions(vector, input.registry, input.expectedQuestionIds);
  if (vector.answers.length !== expectedQuestions.length) throw new Error('Aim factual vector answer membership count mismatch');
  const catalogById = new Map<string, AimEvidenceEntry>();
  for (const entry of vector.evidenceCatalog) {
    if (catalogById.has(entry.evidenceId)) throw new Error(`duplicate Aim evidence ID ${entry.evidenceId}`);
    assertEvidenceEntry(entry, canonicalOriginalJd, trustedMetadata);
    catalogById.set(entry.evidenceId, entry);
  }
  const orderedCatalog = sourceOrderAimEvidenceCatalog(vector.evidenceCatalog);
  if (canonicalJson(orderedCatalog) !== canonicalJson(vector.evidenceCatalog)) throw new Error('Aim evidence catalog is not in source order');
  const catalogIndex = new Map(orderedCatalog.map((entry, index) => [entry.evidenceId, index]));
  const referencedEvidence = new Set<string>();

  vector.answers.forEach((answer, index) => {
    const question = expectedQuestions[index];
    if (!question || answer.questionId !== question.id) throw new Error(`Aim answer order mismatch at ${index}`);
    const expectedEvidenceCount = question.evidenceRule[answer.answer];
    if (answer.evidenceIds.length < expectedEvidenceCount.minimumExactExcerpts
      || answer.evidenceIds.length > expectedEvidenceCount.maximumExactExcerpts) {
      throw new Error(`${answer.questionId} has invalid evidence cardinality`);
    }
    const indexes = answer.evidenceIds.map((evidenceId) => {
      const entry = catalogById.get(evidenceId);
      if (!entry) throw new Error(`${answer.questionId} references unknown evidence ${evidenceId}`);
      if (!question.allowedSources.includes(entry.source)) throw new Error(`${answer.questionId} uses an unauthorized evidence source`);
      if (entry.source === 'trusted_metadata' && (entry.field === null || !question.allowedMetadataFields.includes(entry.field))) {
        throw new Error(`${answer.questionId} uses an unauthorized metadata field`);
      }
      referencedEvidence.add(evidenceId);
      return catalogIndex.get(evidenceId)!;
    });
    if (indexes.some((value, evidenceIndex) => evidenceIndex > 0 && value <= indexes[evidenceIndex - 1])) {
      throw new Error(`${answer.questionId} evidence IDs are not in catalog order`);
    }
    const evidenceEntries = answer.evidenceIds.map((evidenceId) => catalogById.get(evidenceId)!);
    const totalCodePoints = evidenceEntries.reduce((sum, entry) => sum + codePointLength(entry.exactQuote), 0);
    if (totalCodePoints > question.evidenceRule.maximumTotalExcerptCodePoints) throw new Error(`${answer.questionId} evidence exceeds its combined limit`);
    // Machine guards establish positive propositions. Running one against a
    // negative answer incorrectly requires evidence of the very fact it denies.
    if (input.policy && answer.answer === 'yes') assertMachineGuard(question, evidenceEntries, input.policy);
  });
  if (referencedEvidence.size !== vector.evidenceCatalog.length) throw new Error('Aim evidence catalog contains an unreferenced entry');
  const uniqueEvidenceCodePoints = vector.evidenceCatalog.reduce((sum, entry) => sum + codePointLength(entry.exactQuote), 0);
  if (uniqueEvidenceCodePoints > 160_000) throw new Error('Aim factual vector exceeds the unique-evidence limit');
  if (vector.evidenceCatalog.some((entry, index) => index > 0 && compareAimEvidenceEntries(vector.evidenceCatalog[index - 1], entry) > 0)) {
    throw new Error('Aim evidence catalog is not deterministically ordered');
  }

  const factualVectorHash = aimFactualVectorHash(vector);
  if (vector.factualVectorHash !== factualVectorHash) throw new Error('Aim factual vector hash mismatch');
  return vector;
}
