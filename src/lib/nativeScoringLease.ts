/**
 * Lease rules shared by the dashboard and the local watcher daemon.
 *
 * This module stays free of Prisma imports on purpose: the watcher runs its own
 * PrismaClient, so importing the request helpers here would open a second
 * connection pool against the same Postgres host.
 */

export const NATIVE_SCORING_STALE_AFTER_MS = 15 * 60 * 1000;

export interface NativeScoringLease {
  status: string;
  heartbeatAt: Date | null;
  claimedAt: Date | null;
  updatedAt: Date;
}

/**
 * A claimed request is stranded once its worker stops sending heartbeats. Only
 * `running` requests hold a lease — a `queued` request has no worker yet, and a
 * terminal one has released it.
 */
export function nativeScoringLeaseExpired(
  request: NativeScoringLease,
  now: number = Date.now(),
): boolean {
  if (request.status !== 'running') return false;
  const lastBeat = request.heartbeatAt || request.claimedAt || request.updatedAt;
  return now - lastBeat.getTime() > NATIVE_SCORING_STALE_AFTER_MS;
}
