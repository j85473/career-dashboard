export type ActiveScoreVersionCandidate = {
  id: string;
  passReason: string | null;
  tailoringStaged: boolean;
};

export type StandardScoreProvenance = {
  promptVersion: string;
  passed: boolean;
  createdAt: Date;
  staleAt?: Date | null;
};

export type StandardScoreVersionEvent = {
  jobId: string;
  promptVersion: string;
  staleAt?: Date | null;
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

export type NativeReplaySelectionComponents = {
  currentPromptVersion: string;
  contextJobIds: string[];
  directlyEligibleStandardJobIds: string[];
  staleInboxRefreshJobIds: string[];
  dismissedRecoveryJobIds: string[];
  projectedAllWaveStandardCandidateIds: string[];
};

/**
 * The timestamp is intentionally not part of this input. The hash is a stable
 * receipt for candidate membership and scoring authority, while the audit
 * reports snapshotGeneratedAt separately.
 */
export function nativeReplaySelectionHash(components: NativeReplaySelectionComponents): string {
  return createHash('sha256')
    .update(`${JSON.stringify(components)}\n`)
    .digest('hex');
}

export function projectedNativeReplayBatchCount(candidateCount: number, batchSize: number): number {
  if (!Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error('Native replay candidate count must be a non-negative integer');
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Native replay batch size must be a positive integer');
  }
  return Math.ceil(candidateCount / batchSize);
}

const RECOVERABLE_TARGET_TITLE = /\b(?:account executive|account director|account manager|customer success|client success|channel|partner(?:ship)?s?|territory|regional sales|district sales|sales manager|field sales|business development|client partner|commercial)\b/i;

function isExplicitUserPromotion(reason: string | null): boolean {
  return /promoted by user/i.test(reason || '');
}

/**
 * Events must be newest-first. A stale newest event deliberately suppresses
 * older provenance for that job so the active row is selected for a fresh,
 * append-only evaluation instead of silently falling back to old authority.
 */
export function latestUsablePromptVersions(
  newestFirstEvents: StandardScoreVersionEvent[],
): Map<string, string> {
  const versions = new Map<string, string>();
  const observedJobs = new Set<string>();
  for (const event of newestFirstEvents) {
    if (observedJobs.has(event.jobId)) continue;
    observedJobs.add(event.jobId);
    if (!event.staleAt) versions.set(event.jobId, event.promptVersion);
  }
  return versions;
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
        && !event.staleAt
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
import { createHash } from 'node:crypto';
