import type { Prisma } from '@prisma/client';

export const ATS_PRESSURE_LISTING_CONCURRENCY = 1;
// One bounded coverage producer can run alongside a continuing listing while
// six of the eight shared slots remain available to downstream drain work.
export const ATS_COHORT_PRESSURE_LISTING_CONCURRENCY = 2;
export const ATS_LISTING_CAPACITY_LOCK = 'ats-listing-continuation-capacity-v1';

/**
 * Run inside the same transaction that claims the batch. The shared lock
 * serializes only listing admissions, across every host, so two workers cannot
 * both observe the last available producer slot and take it.
 */
export async function withAtsListingCapacity<T>(
  transaction: Pick<Prisma.TransactionClient, '$executeRaw' | 'atsIngestionBatch'>,
  now: Date,
  maximumListingClaims: number,
  claim: () => Promise<T | null>,
): Promise<T | null> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ATS_LISTING_CAPACITY_LOCK}, 0))`;
  const drain = await transaction.atsIngestionBatch.findFirst({
    where: {
      writerMode: 'v2', platform: { not: 'gusto' },
      status: { in: ['fetching', 'partial', 'synchronized', 'reset_draining'] },
      acquisitionPhase: { in: ['compaction', 'enrichment', 'sealing'] },
    }, select: { id: true },
  });
  // With no unfinished drain work, listing is the work that can create
  // the next drainable batch. Lend idle capacity rather than deadlocking a
  // catalog consisting entirely of incomplete listing traversals.
  if (!drain) return claim();
  const liveListings = await transaction.atsIngestionBatch.count({
    where: {
      writerMode: 'v2', platform: { not: 'gusto' },
      status: { in: ['fetching', 'partial', 'synchronized', 'reset_draining'] },
      acquisitionPhase: 'listing', acquisitionClaimToken: { not: null },
      acquisitionLeaseExpiresAt: { gt: now },
    },
  });
  const limit = Number.isFinite(maximumListingClaims) ? Math.max(1, Math.floor(maximumListingClaims)) : 1;
  if (liveListings >= limit) return null;
  return claim();
}
