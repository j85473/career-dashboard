import {
  assessJobDescriptionQuality,
  type JobDescriptionQuality,
} from './jobDescriptionQuality';

export const MAX_JD_RECOVERY_ATTEMPTS = 3;
export const JD_RECOVERY_MANUAL_REVIEW_REASON = 'JD recovery failed after 3 attempts. Manual review required.';

export type JdRecoveryDecision =
  | {
      kind: 'ready';
      text: string;
      quality: JobDescriptionQuality;
    }
  | {
      kind: 'retry';
      nextAttempts: number;
      terminal: boolean;
      reason: string;
      quality: JobDescriptionQuality;
    };

/**
 * One fail-closed contract for text entering local scoring from JD recovery.
 * A long response is not necessarily a job description: it may be a portal,
 * cookie page, error page, or content without usable duties/qualifications.
 */
export function decideJdRecovery(
  value: string | null | undefined,
  currentAttempts: number,
): JdRecoveryDecision {
  const text = value || '';
  const quality = assessJobDescriptionQuality(text);
  if (quality.scorable) return { kind: 'ready', text, quality };

  const nextAttempts = Math.max(0, currentAttempts) + 1;
  return {
    kind: 'retry',
    nextAttempts,
    terminal: nextAttempts >= MAX_JD_RECOVERY_ATTEMPTS,
    reason: quality.reason || 'job description failed quality validation',
    quality,
  };
}

/**
 * Terminal JD extraction is an operational failure, not a job disposition.
 * Keep the job's current active status so Action Needed can surface it while
 * `scoringStatus = failed` prevents another automatic extraction attempt.
 */
export function buildTerminalJdRecoveryUpdate(
  scoreError: string,
  passReason = JD_RECOVERY_MANUAL_REVIEW_REASON,
) {
  return {
    scoreAttempts: MAX_JD_RECOVERY_ATTEMPTS,
    scoringStatus: 'failed' as const,
    scoreError,
    passReason,
  };
}
