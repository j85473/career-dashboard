import {
  assessJobDescriptionQuality,
  isClosedJobPosting,
  isStructuredAtsSource,
  type JobDescriptionQuality,
  type JobDescriptionQualityOptions,
} from './jobDescriptionQuality';

export const MAX_JD_RECOVERY_ATTEMPTS = 3;
export const JD_RECOVERY_MANUAL_REVIEW_REASON = 'JD recovery failed after 3 attempts. Manual review required.';
export const CLOSED_POSTING_REASON = 'Job posting is closed.';

export type JdRecoveryDecision =
  | {
      kind: 'closed';
      text: string;
    }
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

export type JdRecoveryReconciliationPlan = {
  action: 'dismiss_closed' | 'queue_local' | 'retry_extraction';
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
  qualityOptions: JobDescriptionQualityOptions = {},
): JdRecoveryDecision {
  const text = value || '';
  if (isClosedJobPosting(text)) return { kind: 'closed', text };
  const quality = assessJobDescriptionQuality(text, qualityOptions);
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
 * Classify terminal false-rejection rows without broad status-based requeues.
 *
 * A closed posting is dismissed. A description accepted by the corrected gate
 * returns directly to local scoring. Every other terminal JD failure gets one
 * fresh bounded recovery series; only a new terminal failure returns it to
 * Action Needed.
 */
export function planJdRecoveryReconciliation(input: {
  description: string | null | undefined;
  source: string | null | undefined;
}): JdRecoveryReconciliationPlan {
  const structuredSource = isStructuredAtsSource(input.source);
  const quality = assessJobDescriptionQuality(input.description || '', { structuredSource });
  if (isClosedJobPosting(input.description)) return { action: 'dismiss_closed', quality };
  if (quality.scorable) return { action: 'queue_local', quality };
  return { action: 'retry_extraction', quality };
}

export function buildClosedPostingUpdate() {
  return {
    status: 'dismissed' as const,
    scoringStatus: 'skipped' as const,
    scoreAttempts: 0,
    scoreError: null,
    passReason: CLOSED_POSTING_REASON,
    jdBatchId: null,
    batchJobId: null,
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
