export const STANDARD_AIM_PASS_SCORE = 80;
export const STANDARD_EXPERIENCE_PASS_SCORE = 60;
export const DOMAIN_MISMATCH_EXPERIENCE_CAP = 59;
export const YEARS_DEFICIT_EXPERIENCE_CAP = 59;
export const WILDCARD_PASS_SCORE = 85;

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function passesStandardScoring(aimFitScore: number, experienceFitScore: number): boolean {
  return aimFitScore >= STANDARD_AIM_PASS_SCORE
    && experienceFitScore >= STANDARD_EXPERIENCE_PASS_SCORE;
}

export function applyExperienceGuardrails(
  experienceFitScore: number,
  domainMatch: boolean,
  requiredYearsInDomain: number | null,
  candidateYearsInDomain: number | null,
): number {
  let guardedScore = clampScore(experienceFitScore);
  const hasExplicitYearsDeficit = requiredYearsInDomain !== null
    && candidateYearsInDomain !== null
    && candidateYearsInDomain < requiredYearsInDomain;

  if (!domainMatch) {
    guardedScore = Math.min(guardedScore, DOMAIN_MISMATCH_EXPERIENCE_CAP);
  }
  if (hasExplicitYearsDeficit) {
    guardedScore = Math.min(guardedScore, YEARS_DEFICIT_EXPERIENCE_CAP);
  }
  return guardedScore;
}

export function passesWildcardScoring(vibeFitScore: number, experienceFitScore: number): boolean {
  return vibeFitScore >= WILDCARD_PASS_SCORE
    && experienceFitScore >= WILDCARD_PASS_SCORE;
}
