import type { JobPostingLiveness } from './jobPostingVerification';
import { LOCAL_SCORING_TERMINAL_ATTEMPTS } from './localScoringPolicy';

export const ADP_APPLICATION_UNAVAILABLE_REASON = 'ADP application page is currently unavailable. Open the employer site or retry verification before Aim review.';

/** Only new, unscored jobs can be withheld by this prospective gate. */
export function adpPreScoringDisposition(outcome: JobPostingLiveness, hasSavedScores: boolean) {
  if (hasSavedScores) return null;
  if (outcome === 'expired') return {
    status: 'expired' as const,
    scoringStatus: 'skipped' as const,
    passReason: 'Expired (ADP posting closed)',
    batchJobId: null,
    scoreAttempts: 0,
    scoreError: null,
  };
  if (outcome === 'unavailable') return {
    scoringStatus: 'failed' as const,
    batchJobId: null,
    scoreAttempts: LOCAL_SCORING_TERMINAL_ATTEMPTS,
    scoreError: ADP_APPLICATION_UNAVAILABLE_REASON,
  };
  return null;
}
