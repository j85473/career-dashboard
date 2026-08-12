export const STANDARD_AIM_PASS_SCORE = 80;
export const STANDARD_EXPERIENCE_PASS_SCORE = 70;
export type CriterionOutcome = 'direct' | 'partial' | 'cannot_evaluate' | 'does_not_meet' | 'excluded';

export const AIM_HARD_STOP_CODES = [
  'inside_sales',
  'personal_hunting_over_one_third',
  'non_minneapolis_base_required',
  'part_time_temporary_contract_or_1099',
  'consumer_store_sales',
  'religious_employer',
  'direct_pepsico_employer',
  'direct_att_employer',
  'local_insurance_agency',
  'total_comp_below_60000',
] as const;

export type AimHardStopCode = typeof AIM_HARD_STOP_CODES[number];
export type AimHardStopState = 'present' | 'absent' | 'unclear';

export const AIM_RUBRIC_POINTS = {
  coreWork: { exceptional_archetype: 40, strong_fit: 34, acceptable_fit: 26, weaker_but_eligible: 16, unclear: 26 },
  buildingAutonomy: { ground_floor_or_major_ownership: 25, strong_ownership_or_growth: 19, some_influence: 12, little_building_or_autonomy: 5, unclear: 12 },
  productIndustry: { highly_fascinating: 20, interesting_technology: 14, slight_positive: 6, neutral_or_unclear: 0 },
  travel: { international: 15, national_air: 12, overnight_regional: 8, local_territory: 4, mode_unspecified: 4, none_or_unstated: 0 },
} as const;

export type AimRubricBands = {
  -readonly [Category in keyof typeof AIM_RUBRIC_POINTS]: keyof typeof AIM_RUBRIC_POINTS[Category];
};

export function deriveAimDecision(input: {
  hardStops: Readonly<Record<AimHardStopCode, AimHardStopState>>;
  rubric: AimRubricBands | null;
}): { decision: 'survivor' | 'rejected_hard_stop'; aimFitScore: number | null; hardStopCodes: AimHardStopCode[] } {
  const hardStopCodes = AIM_HARD_STOP_CODES.filter((code) => input.hardStops[code] === 'present');
  if (hardStopCodes.length > 0) {
    if (input.rubric !== null) throw new Error('hard-stop rejection must not carry rubric bands');
    return { decision: 'rejected_hard_stop', aimFitScore: null, hardStopCodes };
  }
  if (!input.rubric) throw new Error('Aim survivor must carry all rubric bands');
  const rubric = input.rubric;
  const aimFitScore = (Object.keys(AIM_RUBRIC_POINTS) as Array<keyof typeof AIM_RUBRIC_POINTS>)
    .reduce((sum, category) => sum + Number(AIM_RUBRIC_POINTS[category][rubric[category] as never]), 0);
  return { decision: 'survivor', aimFitScore, hardStopCodes: [] };
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

export function passesStandardScoring(aimFitScore: number, experienceFitScore: number): boolean {
  return aimFitScore >= STANDARD_AIM_PASS_SCORE
    && experienceFitScore >= STANDARD_EXPERIENCE_PASS_SCORE;
}

export interface StandardAdmissionDecision {
  machinePassed: boolean;
  overrideApplied: boolean;
  admittedToInbox: boolean;
}

/**
 * Keeps the immutable model result separate from a lifecycle-only priority override.
 * The override may admit a job, but it must never be persisted as an A/E pass.
 */
export function standardAdmissionDecision(
  aimFitScore: number,
  experienceFitScore: number,
  priorityPolicyMatch: boolean,
): StandardAdmissionDecision {
  const machinePassed = passesStandardScoring(aimFitScore, experienceFitScore);
  const overrideApplied = priorityPolicyMatch && !machinePassed;
  return {
    machinePassed,
    overrideApplied,
    admittedToInbox: machinePassed || overrideApplied,
  };
}
