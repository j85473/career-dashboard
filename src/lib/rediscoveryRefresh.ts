import {
  assessJobDescriptionQuality,
  isScorableJobDescription,
  MIN_SCORABLE_JD_CHARACTERS,
  type JobDescriptionQualityOptions,
} from './jobDescriptionQuality';
import { isManualImportSource } from './manualImportPolicy';

export const REDISCOVERY_REFRESH_REASON = 'exact_source_rediscovery_supplied_scorable_jd';

export type RediscoveryRefreshCandidate = {
  status: string;
  scoringStatus: string;
  source: string | null;
  description: string | null;
  tailoringStaged: boolean;
  aimFitScore: number | null;
  reqFitScore: number | null;
  batchJobId: string | null;
  jdBatchId: string | null;
  afBatchId: string | null;
  userLifecycleEventCount: number;
  leasedScoringItemCount: number;
};

export type RediscoveryRefreshDecision =
  | { refresh: false; reason: string }
  | { refresh: true; reason: typeof REDISCOVERY_REFRESH_REASON; storedLength: number; incomingLength: number };

const ACTIVE_STATUSES = ['pending_af', 'inbox'] as const;

/**
 * Should a same-source rediscovery replace the stored job description?
 *
 * The audit found that when a provider later serves a usable description for a
 * posting it previously served badly, the rediscovery is discarded as an
 * ordinary duplicate and the job stays stuck. This allows the refresh, but only
 * in the one situation where it cannot destroy anything:
 *
 * - the stored description is not scorable, so no scoring ever ran on it;
 * - the incoming description is scorable and longer;
 * - the job carries no Aim or Experience score, no lease, no batch marker, no
 *   user decision, no staged tailoring, and is not a Manual Import.
 *
 * Under those conditions there is no prior judgment to overwrite. Anything with
 * a score, a decision, or work in flight is left exactly where it is — a JD
 * swap under a scored job is a scoring-input change, which is a different and
 * much heavier operation than this.
 *
 * Visible effect: a posting sitting in Action Needed with an unusable
 * description returns to the scoring queue. That adds work to the queue; it
 * never removes or hides any.
 */
export function decideRediscoveryRefresh(
  candidate: RediscoveryRefreshCandidate,
  incomingDescription: string | null | undefined,
  qualityOptions: JobDescriptionQualityOptions = {},
): RediscoveryRefreshDecision {
  if (!(ACTIVE_STATUSES as readonly string[]).includes(candidate.status)) {
    return { refresh: false, reason: 'job_is_not_active' };
  }
  if (isManualImportSource(candidate.source)) return { refresh: false, reason: 'manual_import_protected' };
  if (candidate.tailoringStaged) return { refresh: false, reason: 'tailoring_staged' };
  if (candidate.userLifecycleEventCount > 0) return { refresh: false, reason: 'explicit_user_event_veto' };
  if (candidate.aimFitScore !== null || candidate.reqFitScore !== null) {
    return { refresh: false, reason: 'job_already_carries_a_score' };
  }
  if (candidate.leasedScoringItemCount > 0
    || candidate.batchJobId || candidate.jdBatchId || candidate.afBatchId) {
    return { refresh: false, reason: 'active_or_ambiguous_lease' };
  }
  if (candidate.scoringStatus === 'scoring') return { refresh: false, reason: 'scoring_in_flight' };

  const stored = String(candidate.description || '');
  const incoming = String(incomingDescription || '');
  if (isScorableJobDescription(stored, qualityOptions)) {
    return { refresh: false, reason: 'stored_description_is_already_scorable' };
  }
  const incomingQuality = assessJobDescriptionQuality(incoming, qualityOptions);
  if (!incomingQuality.scorable) return { refresh: false, reason: 'incoming_description_is_not_scorable' };
  if (incoming.trim().length <= stored.trim().length) {
    return { refresh: false, reason: 'incoming_description_is_not_longer' };
  }
  if (incoming.trim().length < MIN_SCORABLE_JD_CHARACTERS) {
    return { refresh: false, reason: 'incoming_description_is_below_the_length_floor' };
  }

  return {
    refresh: true,
    reason: REDISCOVERY_REFRESH_REASON,
    storedLength: stored.trim().length,
    incomingLength: incoming.trim().length,
  };
}

/** Field writes that return a refreshed job to local scoring. */
export function rediscoveryRefreshUpdate(description: string) {
  return {
    description,
    scoringStatus: 'queued' as const,
    scoreAttempts: 0,
    scoreError: null,
    passReason: null,
    batchJobId: null,
    jdBatchId: null,
  };
}
