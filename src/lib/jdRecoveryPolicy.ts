import {
  assessJobDescriptionQuality,
  isClosedJobPosting,
  isStructuredAtsSource,
  type JobDescriptionQuality,
  type JobDescriptionQualityOptions,
} from './jobDescriptionQuality';

export const MAX_JD_RECOVERY_ATTEMPTS = 3;
export const JD_RECOVERY_MANUAL_REVIEW_REASON = 'JD recovery failed after 3 attempts. Manual review required.';
export const AGGREGATOR_SNIPPET_DISCARD_REASON = 'Aggregator listing with no retrievable full description; not reviewable by hand.';
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
 * The quality gate has its own detector for dead pages. A shell is still worth
 * one bounded retry series — a cookie wall can let a later fetch through — but
 * once those attempts are spent it is a closed posting, not something a human
 * can review.
 *
 * The empty-description exclusion is the load-bearing part. It was written
 * expecting to dismiss a large population of dead pages; the first real
 * reconciliation run found *zero* of them, and 202 rows that reported the same
 * quality reason purely because they had no description at all. Without the
 * guard this function would have dismissed all 202 — exactly the postings the
 * SmartRecruiters/Workable/BambooHR detail fetches exist to recover. Its value
 * is what it refuses to do.
 */
const CLOSED_SHELL_REASON = 'expired, closed, login, cookie, or portal shell';

export function qualityIndicatesClosedPosting(
  description: string | null | undefined,
  quality: { scorable: boolean; reason?: string | null },
): boolean {
  // An empty description means nothing was fetched yet — which is the whole
  // reason the SmartRecruiters/Workable/BambooHR detail calls exist. Treating
  // it as a dead posting would dismiss exactly the jobs those calls recover.
  if (!String(description || '').trim()) return false;
  return !quality.scorable && quality.reason === CLOSED_SHELL_REASON;
}

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
  if (qualityIndicatesClosedPosting(input.description, quality)) return { action: 'dismiss_closed', quality };
  if (quality.scorable) return { action: 'queue_local', quality };
  return { action: 'retry_extraction', quality };
}

/**
 * A label that separates "we never fetched this" from "the page is dead".
 *
 * `assessJobDescriptionQuality` reports both as
 * "expired, closed, login, cookie, or portal shell", because
 * `looksLikeInvalidJobDescription('')` is true. Printing that raw reason made a
 * reconciliation dry run read as 202 dead pages when every one of them was an
 * empty description — a posting whose body simply was never retrieved, and
 * which the ATS detail fetches exist to recover. The two call for opposite
 * responses, so the operator-facing summary must not conflate them.
 */
export function describeJdFailureCause(
  description: string | null | undefined,
  quality: { scorable: boolean; reason?: string | null },
): string {
  if (!String(description || '').trim()) return 'no description ever fetched';
  if (quality.reason === CLOSED_SHELL_REASON) return 'dead page (expired, closed, login, cookie, or portal shell)';
  return quality.reason || 'ready';
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
 * Terminal outcome for a listing from a snippet-only aggregator.
 *
 * These postings cannot be repaired by hand — the aggregator never publishes a
 * full description and its URL is an interstitial, so asking a human to review
 * one is asking them to do something impossible. Dismiss instead of routing to
 * Action Needed. `scripts/resolve_adzuna_descriptions.ts` is the only thing
 * that can recover them, by resolving the interstitial in a browser offline.
 */
export function buildAggregatorDiscardUpdate(scoreError: string) {
  return {
    scoreAttempts: MAX_JD_RECOVERY_ATTEMPTS,
    scoringStatus: 'skipped' as const,
    status: 'dismissed' as const,
    scoreError,
    passReason: AGGREGATOR_SNIPPET_DISCARD_REASON,
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
