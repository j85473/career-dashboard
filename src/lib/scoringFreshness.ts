export type ActiveScoreVersionCandidate = {
  id: string;
  passReason: string | null;
  tailoringStaged: boolean;
};

export type StandardScoreProvenance = {
  promptVersion: string;
  passed: boolean;
  createdAt: Date;
};

export type DismissedRecoveryCandidate = {
  id: string;
  title: string;
  aimFitScore: number | null;
  reqFitScore: number | null;
  localFilterPasses: boolean;
};

export const RECENT_DISMISSED_RECOVERY_DAYS = 21;
export const RECENT_DISMISSED_RECOVERY_LIMIT = 500;

const RECOVERABLE_TARGET_TITLE = /\b(?:account executive|account director|account manager|customer success|client success|channel|partner(?:ship)?s?|territory|regional sales|district sales|sales manager|field sales|business development|client partner|commercial)\b/i;

function isExplicitUserPromotion(reason: string | null): boolean {
  return /promoted by user/i.test(reason || '');
}

export function staleActiveScoreIds(
  candidates: ActiveScoreVersionCandidate[],
  latestPromptVersionByJob: ReadonlyMap<string, string>,
  currentPromptVersion: string,
): string[] {
  return candidates
    .filter((job) => !job.tailoringStaged)
    .filter((job) => !isExplicitUserPromotion(job.passReason))
    .filter((job) => latestPromptVersionByJob.get(job.id) !== currentPromptVersion)
    .map((job) => job.id);
}

/**
 * Selects a bounded one-time recovery set from recent AI dismissals. This is
 * deliberately narrower than a historical rescore: it requires fresh standard
 * A/E provenance, current local-filter eligibility, and either a target role
 * family or a meaningful prior near-miss signal.
 */
export function recentDismissedRecoveryIds(
  candidates: DismissedRecoveryCandidate[],
  latestStandardEventByJob: ReadonlyMap<string, StandardScoreProvenance>,
  currentPromptVersion: string,
  cutoff: Date,
  limit: number,
): string[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  return candidates
    .filter((job) => job.localFilterPasses)
    .filter((job) => {
      const event = latestStandardEventByJob.get(job.id);
      return Boolean(
        event
        && !event.passed
        && event.promptVersion !== currentPromptVersion
        && event.createdAt >= cutoff,
      );
    })
    .filter((job) => (
      RECOVERABLE_TARGET_TITLE.test(job.title)
      || (job.aimFitScore || 0) >= 65
      || (job.reqFitScore || 0) >= 70
    ))
    .sort((left, right) => {
      const leftTarget = RECOVERABLE_TARGET_TITLE.test(left.title) ? 1 : 0;
      const rightTarget = RECOVERABLE_TARGET_TITLE.test(right.title) ? 1 : 0;
      return rightTarget - leftTarget
        || (right.reqFitScore || 0) - (left.reqFitScore || 0)
        || (right.aimFitScore || 0) - (left.aimFitScore || 0)
        || left.id.localeCompare(right.id);
    })
    .slice(0, boundedLimit)
    .map((job) => job.id);
}
