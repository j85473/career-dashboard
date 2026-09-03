export { STANDARD_EXPERIENCE_PASS_SCORE } from './experienceFit';
import { assertExactCodePointQuote } from './scoringCanonicalJson';

export type CriterionOutcome = 'direct' | 'partial' | 'cannot_evaluate' | 'does_not_meet' | 'excluded';

export const EXPERIENCE_HARD_REQUIREMENT_CATEGORIES = [
  'minimum_experience',
  'industry_experience',
  'role_specific_experience',
  'role_defining_credential',
] as const;

export type ExperienceHardRequirementCategory = typeof EXPERIENCE_HARD_REQUIREMENT_CATEGORIES[number];

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonRecord;
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

const ABSOLUTE_BAR_CUE = /(?:\bminimum\b|\bmust\s+have\b|\brequired\b|\brequires\b|\bat\s+least\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s+years?\b)/iu;
const EXPERIENCE_RANGE = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:-|\u2013|\u2014|to)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s+years?\b/iu;
const WAIVABLE_REQUIREMENT = /\b(?:(?:may|can)\s+be\s+waived|waivers?\s+(?:may|can)\s+be\s+(?:granted|considered)|exceptions?\s+(?:may|can|will)\s+be\s+(?:made|considered)|case(?:\s+|-)?by(?:\s+|-)?case)\b/iu;

/**
 * Requirements and phrasings that can never be a hard mismatch, split by
 * where it is safe to look for them.
 *
 * `always` terms are scanned in the model's own characterization of the
 * requirement *and* in its JD quote: citizenship and physical-demand language
 * does not appear incidentally inside a genuine experience minimum.
 *
 * `assertionOnly` terms are scanned in the characterization alone. Words such
 * as "travel", "relocation", or "you will" appear routinely inside the same
 * sentence as a real experience floor ("requires 8+ years of field sales
 * experience; you will travel 50%"), so scanning the quote for them rejected
 * legitimate mismatches and pushed those jobs into Action Needed.
 */
const EXCLUDED_REQUIREMENT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
  scope: 'always' | 'assertionOnly';
}> = [
  {
    pattern: EXPERIENCE_RANGE,
    label: 'stated experience range',
    scope: 'always',
  },
  {
    pattern: WAIVABLE_REQUIREMENT,
    label: 'waivable qualification',
    scope: 'always',
  },
  {
    pattern: /\b(?:preferred|nice[ -]to[ -]have|bonus|ideally|desired)\b/iu,
    label: 'preferred or nice-to-have',
    scope: 'always',
  },
  {
    pattern: /\b(?:citizen(?:ship)?|nationality|work authori[sz]ation|authori[sz]ed to work|visa sponsorship|security clearance)\b/iu,
    label: 'administrative eligibility',
    scope: 'always',
  },
  {
    pattern: /\b(?:background check|drug screen|driver(?:'s)? licen[cs]e|driving record|travel|relocat(?:e|ion))\b/iu,
    label: 'administrative eligibility',
    scope: 'assertionOnly',
  },
  {
    pattern: /\b(?:lift(?:ing)?|push(?:ing)?|pull(?:ing)?|carry(?:ing)?|overhead work|physical(?:ly)? demands?)\b/iu,
    label: 'physical demand',
    scope: 'always',
  },
  {
    pattern: /\b(?:load(?:ing)?|unload(?:ing)?|standing|walking|reaching)\b/iu,
    label: 'physical demand',
    scope: 'assertionOnly',
  },
  {
    pattern: /\b(?:(?:excellent|strong|exceptional|outstanding)\s+(?:communication|presentation|interpersonal|leadership|storytelling|negotiation)\s+(?:skill|skills|ability|abilities)|team player|self[- ]starter|passionate?|comfortable\s+with)\b/iu,
    label: 'subjective trait or skill',
    scope: 'assertionOnly',
  },
  {
    pattern: /\b(?:responsible for|responsibilities include|duties include|day[- ]to[- ]day|you will|you'll)\b/iu,
    label: 'ordinary duty',
    scope: 'assertionOnly',
  },
];

export function excludedRequirementLabel(requirement: string, exactQuote: string): string | null {
  const match = EXCLUDED_REQUIREMENT_PATTERNS.find(({ pattern, scope }) => (
    pattern.test(requirement) || (scope === 'always' && pattern.test(exactQuote))
  ));
  return match ? match.label : null;
}
/**
 * Canonical Experience v2 semantic boundary.
 *
 * The exchange schema proves shape. This check proves that every newly
 * accepted zero-score decision is bound to exact source text and to the
 * exhaustive Candidate Evidence Inventory policy. It deliberately runs only
 * while building a nonterminal preview/apply projection; completed historical
 * imports remain immutable audit history.
 */
export function assertExperienceHardRequirementEvidence(input: {
  result: unknown;
  originalJd: string;
}): void {
  const result = record(input.result, 'Experience result');
  if (result.decision !== 'hard_requirement_mismatch') return;

  if (!Array.isArray(result.hardRequirementsNotMet) || !Array.isArray(result.hardRequirementEvidence)) {
    throw new Error('Experience hard mismatch requires structured requirement evidence');
  }
  const hardRequirementsNotMet = result.hardRequirementsNotMet;
  const hardRequirementEvidence = result.hardRequirementEvidence;
  if (hardRequirementsNotMet.length !== hardRequirementEvidence.length) {
    throw new Error('Experience hard mismatch evidence must cover every unmet requirement');
  }

  const allowedCategories = new Set<string>(EXPERIENCE_HARD_REQUIREMENT_CATEGORIES);
  hardRequirementEvidence.forEach((rawEvidence, index) => {
    const field = `Experience hard mismatch evidence ${index}`;
    const evidence = record(rawEvidence, field);
    const requirement = nonemptyString(evidence.requirement, `${field}.requirement`);
    if (hardRequirementsNotMet[index] !== requirement) {
      throw new Error(`${field} does not match hardRequirementsNotMet`);
    }

    const category = nonemptyString(evidence.category, `${field}.category`);
    if (!allowedCategories.has(category)) throw new Error(`${field} has an excluded requirement category`);

    const source = record(evidence.source, `${field}.source`);
    const exactQuote = nonemptyString(source.exactQuote, `${field}.source.exactQuote`);
    assertExactCodePointQuote(input.originalJd, {
      startCodePoint: Number(source.startCodePoint),
      endCodePoint: Number(source.endCodePoint),
    }, exactQuote);

    const absoluteBarCue = nonemptyString(evidence.absoluteBarCue, `${field}.absoluteBarCue`);
    if (!exactQuote.includes(absoluteBarCue) || !ABSOLUTE_BAR_CUE.test(absoluteBarCue)) {
      throw new Error(`${field} is not bound to a recognized absolute-bar cue in its JD quote`);
    }

    const inventoryComparison = nonemptyString(evidence.inventoryComparison, `${field}.inventoryComparison`);
    if (inventoryComparison.trim().length < 20
      || !/\b(?:inventory|evidence)\b/iu.test(inventoryComparison)
      || !/\b(?:absent|below|does not|doesn't|lacks?|no|not|only|under)\b/iu.test(inventoryComparison)) {
      throw new Error(`${field} has an insufficient Candidate Evidence Inventory comparison`);
    }

    const excluded = excludedRequirementLabel(requirement, exactQuote);
    if (excluded) throw new Error(`${field} is an excluded ${excluded} requirement`);
  });
}

export type CriterionScoringInput = {
  classification: 'required' | 'preferred';
  outcome: CriterionOutcome;
  scoreNeutral?: boolean;
};

export type CriterionExperienceResult = {
  uncappedScore: number;
  experienceFitScore: number;
  cap: 59 | 69 | 79 | null;
  label: 'Fully qualified' | 'Partially qualified' | 'Verification needed' | 'Does not meet';
  requiredCounts: Record<CriterionOutcome, number>;
  preferredCounts: Record<CriterionOutcome, number>;
};

const CRITERION_VALUE: Readonly<Record<CriterionOutcome, number>> = {
  direct: 1,
  partial: 0.5,
  cannot_evaluate: 0,
  does_not_meet: 0,
  excluded: 0,
};

function emptyOutcomeCounts(): Record<CriterionOutcome, number> {
  return { direct: 0, partial: 0, cannot_evaluate: 0, does_not_meet: 0, excluded: 0 };
}

/** Application-owned Experience scoring. Model-supplied aggregates are never trusted. */
export function deriveCriterionExperienceScore(
  criteria: readonly CriterionScoringInput[],
): CriterionExperienceResult {
  const requiredCounts = emptyOutcomeCounts();
  const preferredCounts = emptyOutcomeCounts();
  for (const criterion of criteria) {
    (criterion.classification === 'required' ? requiredCounts : preferredCounts)[criterion.outcome] += 1;
  }

  const scorable = criteria.filter((criterion) => !criterion.scoreNeutral && criterion.outcome !== 'excluded');
  const required = scorable.filter((criterion) => criterion.classification === 'required');
  const preferred = scorable.filter((criterion) => criterion.classification === 'preferred');
  const ratio = (items: readonly CriterionScoringInput[]): number => (
    items.length === 0 ? 0 : items.reduce((sum, item) => sum + CRITERION_VALUE[item.outcome], 0) / items.length
  );
  const uncappedScore = clampScore(scorable.length === 0
    ? 100
    : preferred.length === 0
      ? ratio(required) * 100
      : ratio(required) * 80 + ratio(preferred) * 20);

  const requiredOutcomes = new Set(required.map((criterion) => criterion.outcome));
  const cap = requiredOutcomes.has('does_not_meet')
    ? 59
    : requiredOutcomes.has('cannot_evaluate')
      ? 69
      : requiredOutcomes.has('partial')
        ? 79
        : null;
  const experienceFitScore = cap === null ? uncappedScore : Math.min(uncappedScore, cap);
  const label = requiredOutcomes.has('does_not_meet')
    ? 'Does not meet'
    : requiredOutcomes.has('cannot_evaluate')
      ? 'Verification needed'
      : requiredOutcomes.has('partial')
        ? 'Partially qualified'
        : 'Fully qualified';
  return { uncappedScore, experienceFitScore, cap, label, requiredCounts, preferredCounts };
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
