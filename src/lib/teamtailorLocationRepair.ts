import { evaluateAuthoritativeGeography } from './authoritativeMetadataGate';
import { isScorableJobDescription } from './jobDescriptionQuality';
import { TEAMTAILOR_LOCATION_UNAVAILABLE_REASON } from './teamtailorLocation';

export const TEAMTAILOR_LOCATION_REPAIR_ACTIVE_STATUSES = ['inbox', 'pending_af'] as const;

export type TeamtailorLocationRepairSnapshot = {
  title: string;
  location: string | null;
  url: string | null;
  description: string | null;
  status: string;
  scoringStatus: string;
  passReason: string | null;
};

export type TeamtailorLocationRepairPlan = {
  action: 'metadata_only' | 'archive_out_of_scope' | 'restore_after_recovery' | 'hold_for_recovery';
  location: string;
  status: string;
  scoringStatus: string;
  passReason: string | null;
  geographyPasses: boolean;
  geographyReason: string;
};

/** Hold a legacy active row when its authoritative posting still has no usable location. */
export function planTeamtailorUnavailableLocationHold(
  job: TeamtailorLocationRepairSnapshot,
): TeamtailorLocationRepairPlan {
  return {
    action: 'hold_for_recovery',
    location: String(job.location || '').trim() || 'Unknown Location',
    status: 'archived',
    scoringStatus: 'skipped',
    passReason: TEAMTAILOR_LOCATION_UNAVAILABLE_REASON,
    geographyPasses: false,
    geographyReason: TEAMTAILOR_LOCATION_UNAVAILABLE_REASON,
  };
}

/**
 * Plans only metadata and lifecycle fields. Score fields and score events are
 * intentionally absent: location recovery is prospective information and may
 * archive an ineligible job, but it never erases or invalidates prior scoring.
 */
export function planTeamtailorLocationRepair(
  job: TeamtailorLocationRepairSnapshot,
  recoveredLocation: string,
): TeamtailorLocationRepairPlan {
  const location = recoveredLocation.trim();
  if (!location) throw new Error('A Teamtailor location repair requires a non-empty location.');

  const geography = evaluateAuthoritativeGeography({
    title: job.title,
    location,
    url: job.url,
  });
  if (!geography.passes) {
    return {
      action: 'archive_out_of_scope',
      location,
      status: 'archived',
      scoringStatus: 'skipped',
      passReason: geography.reason,
      geographyPasses: false,
      geographyReason: geography.reason,
    };
  }

  const heldForRecovery = job.status === 'archived'
    && job.passReason === TEAMTAILOR_LOCATION_UNAVAILABLE_REASON;
  if (heldForRecovery) {
    return {
      action: 'restore_after_recovery',
      location,
      status: 'pending_af',
      scoringStatus: isScorableJobDescription(job.description || '', { structuredSource: true })
        ? 'queued'
        : 'needs_jd',
      passReason: null,
      geographyPasses: true,
      geographyReason: '',
    };
  }

  return {
    action: 'metadata_only',
    location,
    status: job.status,
    scoringStatus: job.scoringStatus,
    passReason: job.passReason,
    geographyPasses: true,
    geographyReason: '',
  };
}
