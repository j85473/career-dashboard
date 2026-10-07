export const ATS_LANE_PLAN_MAX_AGE_MS = 1_000;

/**
 * Create once per dispatcher session. All its workers share a pending scan and
 * briefly reuse its result; other sessions keep independent plans. Age starts
 * before the scan, so a slow read does not gain another second of freshness.
 * This caches scheduling hints only, never claim eligibility or admission.
 */
export function createAtsLanePlanReader<T>(
  readPlan: () => Promise<T>,
  now: () => number = () => performance.now(),
): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let pending: Promise<T> | null = null;

  return () => {
    if (pending) return pending;
    const startedAt = now();
    if (cached && startedAt < cached.expiresAt) return Promise.resolve(cached.value);
    cached = null;
    pending = Promise.resolve().then(readPlan).then((value) => {
      cached = { value, expiresAt: startedAt + ATS_LANE_PLAN_MAX_AGE_MS };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}
