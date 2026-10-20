import type { JobPostingLiveness } from './jobPostingVerification';

export const ADP_APPLICATION_UNAVAILABLE_EXPIRED_REASON = 'Expired (ADP application page unavailable)';

/** Only new, unscored jobs can be withheld by this prospective gate. */
export function adpPreScoringDisposition(outcome: JobPostingLiveness, hasSavedScores: boolean) {
  if (hasSavedScores) return null;
  if (outcome === 'expired' || outcome === 'unavailable') return {
    status: 'expired' as const,
    scoringStatus: 'skipped' as const,
    passReason: outcome === 'unavailable'
      ? ADP_APPLICATION_UNAVAILABLE_EXPIRED_REASON : 'Expired (ADP posting closed)',
    batchJobId: null,
    scoreAttempts: 0,
    scoreError: null,
  };
  return null;
}
