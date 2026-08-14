import experiencePolicy from '../../data/scoring/experience-policy-v2.json';

export const STANDARD_EXPERIENCE_PASS_SCORE = experiencePolicy.standardPassScore;

export function experienceScorePasses(score: number): boolean {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error('Experience Fit score must be an integer from 0 to 100');
  }
  return score >= STANDARD_EXPERIENCE_PASS_SCORE;
}
