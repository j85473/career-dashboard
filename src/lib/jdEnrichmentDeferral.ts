/**
 * A JD recovery pass that never reached the provider is not a failed attempt.
 *
 * Search and description calls spend one request ledger per provider, and
 * search runs first. When the ledger is empty the description call is refused
 * before any network request is made. Until now that refusal was swallowed by
 * the caller and the job was written as though the fetch had returned an empty
 * page: `scoringStatus = failed`, three attempts spent, and the reason
 * "expired, closed, login, cookie, or portal shell" — a dead-posting verdict
 * for a posting nobody looked at.
 *
 * This module keeps the two apart. A denied reservation defers the job to the
 * next release window without spending an attempt. Deferral is bounded, so a
 * job whose budget never frees eventually gets a real terminal outcome rather
 * than cycling forever.
 */

/**
 * How many times one job may be deferred before it is treated as a genuine
 * failure. Paid providers release their allowance hourly and a deferral parks
 * the job until the refusal's own retry time, so this is a day of real waiting
 * rather than a day's worth of laps around an empty queue.
 */
export const MAX_JD_ENRICHMENT_DEFERRALS = 24;

/**
 * Used when a refusal carries no retry time of its own. Long enough that a
 * deferral always costs elapsed time: the `needs_jd` queue is routinely empty,
 * so a job parked with no delay would be picked straight back up and would
 * spend its whole budget in minutes, terminalizing during a shortage that was
 * about to clear.
 */
export const DEFAULT_JD_DEFERRAL_MS = 15 * 60_000;

/** A refusal that knows when the provider will have room again. */
export class ProviderCapacityRefusal extends Error {
  readonly retryAt: Date | null;

  constructor(message: string, retryAt: Date | null | undefined) {
    super(message);
    this.name = 'ProviderCapacityRefusal';
    this.retryAt = retryAt || null;
  }
}

const BUDGET_REFUSAL = /request blocked by (?:\w*budget|circuit_open)\b/i;

/**
 * True when the provider was never asked. Matches the refusal text raised by
 * the reservation layer for every budget reason, including
 * `enrichment_budget`, plus an open failure circuit — in both cases no request
 * left the process.
 */
export function isProviderRefusalWithoutRequest(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return BUDGET_REFUSAL.test(message);
}

export type JdEnrichmentDeferral = {
  deferrals: number;
  exhausted: boolean;
  reason: string;
  deferredUntil: Date;
};

export function planJdEnrichmentDeferral(
  currentDeferrals: number,
  error: unknown,
  now: Date = new Date(),
): JdEnrichmentDeferral {
  const deferrals = Math.max(0, currentDeferrals) + 1;
  const message = error instanceof Error ? error.message : String(error ?? '');
  // The reservation already worked out when the next portion is released.
  // Honour it, but never park for less than the default: a retry time that has
  // already passed would put the job straight back in the next batch.
  const carried = error instanceof ProviderCapacityRefusal ? error.retryAt : null;
  const floor = new Date(now.getTime() + DEFAULT_JD_DEFERRAL_MS);
  return {
    deferrals,
    exhausted: deferrals >= MAX_JD_ENRICHMENT_DEFERRALS,
    reason: message || 'provider request refused before any request was made',
    deferredUntil: carried && carried.getTime() > floor.getTime() ? carried : floor,
  };
}

/**
 * Hold the job exactly where it was. `scoreAttempts` is untouched on purpose:
 * the recovery series has not advanced, because nothing was tried.
 */
export function buildJdEnrichmentDeferralUpdate(plan: JdEnrichmentDeferral) {
  return {
    scoringStatus: 'needs_jd' as const,
    jdBatchId: null,
    batchJobId: null,
    jdDeferrals: plan.deferrals,
    jdDeferredUntil: plan.deferredUntil,
    scoreError: `JD enrichment deferred until ${plan.deferredUntil.toISOString()}: ${plan.reason}`,
  };
}

/**
 * The message a job carries once it has waited out its deferral budget. It
 * still says plainly that no description was ever retrieved, so it is never
 * confused with a page that was fetched and found dead.
 */
export const JD_ENRICHMENT_STARVED_REASON =
  'JD enrichment never ran: the provider request budget refused every attempt.';

/**
 * Clear the waiting count when the job stops waiting — whether it got its
 * description or ran out of deferrals.
 *
 * Without this, a job terminalized by exhaustion keeps a maxed-out count, and
 * the claim query would skip it forever if Joseph ever sent it back for
 * another try. The deferral budget is per waiting period, not per job.
 */
export const CLEARED_JD_DEFERRALS = { jdDeferrals: 0, jdDeferredUntil: null } as const;

/**
 * Jobs whose deferral window has passed. A job with no window was never
 * deferred.
 */
export function claimableJdDeferralWhere(now: Date = new Date()) {
  return {
    jdDeferrals: { lt: MAX_JD_ENRICHMENT_DEFERRALS },
    OR: [{ jdDeferredUntil: null }, { jdDeferredUntil: { lte: now } }],
  };
}
