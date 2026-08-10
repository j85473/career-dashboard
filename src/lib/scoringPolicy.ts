export const STANDARD_AIM_PASS_SCORE = 80;
export const STANDARD_EXPERIENCE_PASS_SCORE = 70;
export const DOMAIN_MISMATCH_EXPERIENCE_CAP = 59;
export const YEARS_DEFICIT_EXPERIENCE_CAP = 59;
export const ADJACENT_EXPERIENCE_CAP = 79;
export type QualificationBasis = 'direct' | 'adjacent' | 'unsupported';

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

export function applyExperienceGuardrails(
  experienceFitScore: number,
  mandatoryRequirementsMet: boolean,
  domainMatch: boolean,
  requiredYearsInDomain: number | null,
  candidateYearsInDomain: number | null,
  qualificationBasis: QualificationBasis = 'direct',
): number {
  let guardedScore = clampScore(experienceFitScore);
  const hasExplicitYearsDeficit = requiredYearsInDomain !== null
    && (candidateYearsInDomain === null || candidateYearsInDomain < requiredYearsInDomain);

  if (!mandatoryRequirementsMet || !domainMatch || qualificationBasis === 'unsupported') {
    guardedScore = Math.min(guardedScore, DOMAIN_MISMATCH_EXPERIENCE_CAP);
  }
  if (qualificationBasis === 'adjacent') {
    guardedScore = Math.min(guardedScore, ADJACENT_EXPERIENCE_CAP);
  }
  if (hasExplicitYearsDeficit) {
    guardedScore = Math.min(guardedScore, YEARS_DEFICIT_EXPERIENCE_CAP);
  }
  return guardedScore;
}

export type StandardQualificationSignals = {
  experienceFitScore: number;
  mandatoryRequirementsMet: boolean;
  domainMatch: boolean;
  requiredYearsInDomain: number | null;
  candidateYearsInDomain: number | null;
  qualificationBasis?: QualificationBasis;
};

export function guardedStandardExperienceScore(signals: StandardQualificationSignals): number {
  return applyExperienceGuardrails(
    signals.experienceFitScore,
    signals.mandatoryRequirementsMet,
    signals.domainMatch,
    signals.requiredYearsInDomain,
    signals.candidateYearsInDomain,
    signals.qualificationBasis,
  );
}
