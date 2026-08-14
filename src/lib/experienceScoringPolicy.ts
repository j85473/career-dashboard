export { STANDARD_EXPERIENCE_PASS_SCORE } from './experienceFit';
export type CriterionOutcome = 'direct' | 'partial' | 'cannot_evaluate' | 'does_not_meet' | 'excluded';

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
