import { codePointLength } from './scoringCanonicalJson';
import type { AimEvidenceEntry, AimFactualVector, AimScoringPolicy } from './aimV2Types';

export type AimTravelInterval = {
  lower: number;
  upper: number;
  lowerExplicit: boolean;
  upperExplicit: boolean;
};

export type AimTravelResult = {
  coverageState: 'complete' | 'ambiguous';
  comparisonState: 'comparable' | 'qualitative' | 'missing' | 'conflicting' | 'ambiguous';
  positiveTravel: boolean;
  interval: AimTravelInterval | null;
  qualitativeTerm: string | null;
  geographicReachPoints: number;
  intensityPoints: number;
  fieldEngagementPoints: number;
  points: number;
  legacyTravelScore: number | null;
  reasonCode: string;
};

type ParsedClause = AimTravelInterval & { sourceText: string };

function answers(vector: AimFactualVector): Map<string, AimFactualVector['answers'][number]> {
  return new Map(vector.answers.map((answer) => [answer.questionId, answer]));
}

function evidenceMap(vector: AimFactualVector): Map<string, AimEvidenceEntry> {
  return new Map(vector.evidenceCatalog.map((entry) => [entry.evidenceId, entry]));
}

function questionEvidence(vector: AimFactualVector, questionId: string): AimEvidenceEntry[] {
  const byEvidence = evidenceMap(vector);
  return vector.answers.find((answer) => answer.questionId === questionId)?.evidenceIds.map((id) => byEvidence.get(id)!).filter(Boolean) ?? [];
}

function yes(answerMap: Map<string, AimFactualVector['answers'][number]>, questionId: string): boolean {
  return answerMap.get(questionId)?.answer === 'yes';
}

function pointsForBound(value: number, tiers: unknown): number {
  if (!Array.isArray(tiers)) return 0;
  const match = tiers.find((tier) => {
    if (!tier || typeof tier !== 'object') return false;
    const record = tier as { minimum?: unknown; maximum?: unknown };
    return typeof record.minimum === 'number' && typeof record.maximum === 'number'
      && value >= record.minimum && value <= record.maximum;
  }) as { points?: unknown } | undefined;
  return typeof match?.points === 'number' ? match.points : 0;
}

function escapedAlternatives(values: readonly string[]): string {
  return [...values]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

function parseNumericEvidence(text: string, policy: AimScoringPolicy): ParsedClause[] | null {
  const travelPolicy = policy.travel as {
    numericQualifiers: { lowerBound: string[]; upperBound: string[]; rangeSeparators: string[] };
    domainMinimumPercent: number;
    domainMaximumPercent: number;
  };
  const lowerWords = escapedAlternatives(travelPolicy.numericQualifiers.lowerBound);
  const upperWords = escapedAlternatives(travelPolicy.numericQualifiers.upperBound);
  const rangeSeparators = escapedAlternatives(travelPolicy.numericQualifiers.rangeSeparators);
  const range = new RegExp(`\\b(\\d{1,3})\\s*(?:%|percent)?\\s*(?:${rangeSeparators})\\s*(\\d{1,3})\\s*(?:%|percent)(?!\\p{L})`, 'giu');
  const clauses: ParsedClause[] = [];
  const occupied: Array<[number, number]> = [];
  for (const match of text.matchAll(range)) {
    const lower = Number(match[1]);
    const upper = Number(match[2]);
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower > upper
      || lower < travelPolicy.domainMinimumPercent || upper > travelPolicy.domainMaximumPercent) return null;
    clauses.push({ lower, upper, lowerExplicit: true, upperExplicit: true, sourceText: match[0] });
    occupied.push([match.index!, match.index! + match[0].length]);
  }
  const value = new RegExp(`(?:(?<lower>${lowerWords})|(?<upper>${upperWords}))?\\s*(\\d{1,3})\\s*(?:%|percent)(?!\\p{L})`, 'giu');
  for (const match of text.matchAll(value)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (occupied.some(([left, right]) => start >= left && end <= right)) continue;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number < travelPolicy.domainMinimumPercent || number > travelPolicy.domainMaximumPercent) return null;
    const lower = match.groups?.lower !== undefined;
    const upper = match.groups?.upper !== undefined;
    clauses.push({
      lower: upper ? 0 : number,
      upper: lower ? 100 : number,
      lowerExplicit: !upper,
      upperExplicit: !lower,
      sourceText: match[0],
    });
  }
  const decimalPercentage = /\b\d+\.\d+\s*(?:%|percent)(?!\p{L})/iu.test(text);
  if (decimalPercentage) return null;
  return clauses;
}

type CoverageSpan = { startCodePoint: number; endCodePoint: number };

function recognizedSourceSpans(source: string, kind: 'numeric' | 'no_travel'): CoverageSpan[] {
  const expression = kind === 'numeric'
    ? /(?:\btravel(?:s|ing|led|ling)?\b[^.\n]{0,100}?\b\d+(?:\.\d+)?\s*(?:%|percent)(?!\p{L})|\b\d+(?:\.\d+)?\s*(?:%|percent)(?!\p{L})[^.\n]{0,100}?\btravel(?:s|ing|led|ling)?\b)/giu
    : /\b(?:no\s+travel|travel\s+(?:is\s+)?(?:not\s+required|required\s*[:=-]?\s*0\s*(?:%|percent)|0\s*(?:%|percent)))\b/giu;
  return [...source.matchAll(expression)].map((match) => ({
    startCodePoint: codePointLength(source.slice(0, match.index!)),
    endCodePoint: codePointLength(source.slice(0, match.index! + match[0].length)),
  }));
}

function occurrenceContains(occurrence: CoverageSpan, span: CoverageSpan): boolean {
  return occurrence.startCodePoint <= span.startCodePoint && occurrence.endCodePoint >= span.endCodePoint;
}

export function aimTravelCoverageState(source: string, vector: AimFactualVector): 'complete' | 'ambiguous' {
  const numericEvidence = questionEvidence(vector, 'S2.TR.Q01').filter((entry) => entry.source === 'original_jd');
  const noTravelEvidence = questionEvidence(vector, 'S2.TR.Q02').filter((entry) => entry.source === 'original_jd');
  const numericCovered = recognizedSourceSpans(source, 'numeric').every((span) => numericEvidence.some((entry) => entry.occurrences.some((occurrence) => occurrenceContains(occurrence, span))));
  const noTravelCovered = recognizedSourceSpans(source, 'no_travel').every((span) => noTravelEvidence.some((entry) => entry.occurrences.some((occurrence) => occurrenceContains(occurrence, span))));
  return numericCovered && noTravelCovered ? 'complete' : 'ambiguous';
}

function intersectClauses(clauses: readonly ParsedClause[]): AimTravelInterval | 'conflicting' | null {
  if (clauses.length === 0) return null;
  const lower = Math.max(...clauses.map((clause) => clause.lower));
  const upper = Math.min(...clauses.map((clause) => clause.upper));
  if (lower > upper) return 'conflicting';
  return {
    lower,
    upper,
    lowerExplicit: clauses.some((clause) => clause.lowerExplicit && clause.lower === lower),
    upperExplicit: clauses.some((clause) => clause.upperExplicit && clause.upper === upper),
  };
}

function firstYesTier(answerMap: Map<string, AimFactualVector['answers'][number]>, tiers: Array<[string, number]>): number {
  return tiers.find(([questionId]) => yes(answerMap, questionId))?.[1] ?? 0;
}

export function deriveAimTravel(source: string, vector: AimFactualVector, policy: AimScoringPolicy): AimTravelResult {
  const answerMap = answers(vector);
  const travelPolicy = policy.travel as {
    affirmativeFloorIntensityTiers: unknown;
    explicitUpperIntensityTiers: unknown;
    qualitativeLexemes: Record<string, number>;
    otherPositiveTravelIntensityPoints: number;
  };
  const coverageState = aimTravelCoverageState(source, vector);
  const q1Evidence = questionEvidence(vector, 'S2.TR.Q01');
  const numericClauses: ParsedClause[] = [];
  let numericInvalid = false;
  for (const entry of q1Evidence) {
    const parsed = parseNumericEvidence(entry.exactQuote, policy);
    if (parsed === null) numericInvalid = true;
    else numericClauses.push(...parsed);
  }
  const numericEvidenceText = q1Evidence.map((entry) => entry.exactQuote).join('\n');
  const unknownNumericQualifier = /\b(?:about|approximately|approx\.?|around|roughly|typically|usually|generally|expected|anticipated)\b[^.\n]{0,40}\b\d{1,3}\s*(?:%|percent)/iu.test(numericEvidenceText);
  const conditionedNumericClause = /\b(?:depending\s+on|varies?\s+by|based\s+on|by\s+(?:region|location|season|territory|purpose)|during\s+(?:peak|busy|holiday|summer|winter|spring|fall)|if|when)\b/iu.test(numericEvidenceText);
  if (numericClauses.length > 2 || unknownNumericQualifier || conditionedNumericClause) numericInvalid = true;
  const interval = numericInvalid ? null : intersectClauses(numericClauses);
  const qualitativeEvidence = questionEvidence(vector, 'S2.TR.Q03').map((entry) => entry.exactQuote.toLocaleLowerCase('en-US')).join('\n');
  const qualitativeMatches = Object.entries(travelPolicy.qualitativeLexemes).filter(([term]) => qualitativeEvidence.includes(term.toLocaleLowerCase('en-US')));
  const qualitativeTerm = qualitativeMatches.sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

  const positiveQuestions = Array.from({ length: 11 }, (_, index) => `S2.TR.Q${String(index + 3).padStart(2, '0')}`);
  const numericPositive = interval !== null && interval !== 'conflicting'
    && ((interval.lowerExplicit && interval.lower > 0) || (interval.upperExplicit && interval.upper > 0));
  const positiveTravel = numericPositive || positiveQuestions.some((questionId) => yes(answerMap, questionId));
  const explicitNoTravel = yes(answerMap, 'S2.TR.Q02');
  const zeroOnly = interval !== null && interval !== 'conflicting' && interval.lower === 0 && interval.upper === 0;
  const conflict = interval === 'conflicting' || (explicitNoTravel && positiveTravel) || (zeroOnly && positiveQuestions.some((questionId) => yes(answerMap, questionId)));

  if (coverageState === 'ambiguous' || numericInvalid) {
    return {
      coverageState: 'ambiguous', comparisonState: 'ambiguous', positiveTravel: false,
      interval: null, qualitativeTerm, geographicReachPoints: 0, intensityPoints: 0,
      fieldEngagementPoints: 0, points: 0, legacyTravelScore: null,
      reasonCode: 'travel_coverage_or_numeric_ambiguous',
    };
  }
  if (conflict) {
    return {
      coverageState, comparisonState: 'conflicting', positiveTravel: false,
      interval: interval === 'conflicting' ? null : interval, qualitativeTerm,
      geographicReachPoints: 0, intensityPoints: 0, fieldEngagementPoints: 0,
      points: 0, legacyTravelScore: null, reasonCode: 'travel_source_conflict',
    };
  }

  const geographicReachPoints = firstYesTier(answerMap, [
    ['S2.TR.Q09', 15], ['S2.TR.Q08', 12], ['S2.TR.Q07', 10], ['S2.TR.Q06', 7], ['S2.TR.Q05', 4],
  ]) || (positiveTravel ? 2 : 0);
  let intensityPoints = 0;
  let legacyTravelScore: number | null = null;
  if (interval !== null) {
    const lowerPoints = interval.lowerExplicit ? pointsForBound(interval.lower, travelPolicy.affirmativeFloorIntensityTiers) : 0;
    const upperPoints = interval.upperExplicit ? pointsForBound(interval.upper, travelPolicy.explicitUpperIntensityTiers) : 0;
    intensityPoints = Math.max(lowerPoints, upperPoints);
    legacyTravelScore = interval.upperExplicit ? interval.upper : interval.lowerExplicit ? interval.lower : null;
  } else if (qualitativeTerm !== null) {
    intensityPoints = travelPolicy.qualitativeLexemes[qualitativeTerm];
  } else if (positiveTravel) {
    intensityPoints = travelPolicy.otherPositiveTravelIntensityPoints;
  }
  const fieldEngagementPoints = firstYesTier(answerMap, [
    ['S2.TR.Q10', 5], ['S2.TR.Q11', 4], ['S2.TR.Q12', 3], ['S2.TR.Q13', 2],
  ]) || (positiveTravel ? 1 : 0);
  const points = Math.min(30, geographicReachPoints + intensityPoints + fieldEngagementPoints);
  return {
    coverageState,
    comparisonState: interval !== null ? 'comparable' : qualitativeTerm !== null ? 'qualitative' : 'missing',
    positiveTravel,
    interval,
    qualitativeTerm,
    geographicReachPoints,
    intensityPoints,
    fieldEngagementPoints,
    points,
    legacyTravelScore,
    reasonCode: positiveTravel ? 'travel_scored' : explicitNoTravel || zeroOnly ? 'explicit_zero_travel' : 'travel_not_supported',
  };
}
