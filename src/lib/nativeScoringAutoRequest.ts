export const AUTO_NATIVE_SCORING_THRESHOLD = 3;
export const AUTO_NATIVE_SCORING_MAX_WAIT_MS = 15 * 60 * 1000;
export const AUTO_NATIVE_SCORING_POLL_MS = 60 * 1000;

export function shouldAutoRequestNativeScoring(input: {
  eligibleCount: number;
  oldestEligibleAt?: Date | null;
  activeRequestStatus?: string | null;
  now?: Date;
}): { create: boolean; reason: string } {
  if (input.activeRequestStatus) {
    return {
      create: false,
      reason: input.activeRequestStatus === 'failed'
        ? 'active_failed_request_requires_action'
        : 'single_flight_request_active',
    };
  }
  if (input.eligibleCount <= 0) return { create: false, reason: 'no_eligible_jobs' };
  if (input.eligibleCount >= AUTO_NATIVE_SCORING_THRESHOLD) {
    return { create: true, reason: 'queue_threshold' };
  }
  const now = input.now || new Date();
  if (
    input.oldestEligibleAt
    && now.getTime() - input.oldestEligibleAt.getTime() >= AUTO_NATIVE_SCORING_MAX_WAIT_MS
  ) {
    return { create: true, reason: 'oldest_wait_sla' };
  }
  return { create: false, reason: 'waiting_for_threshold_or_sla' };
}
