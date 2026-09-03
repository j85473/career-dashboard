/**
 * Bring back listing batches that were parked for a week over a refusal the
 * pipeline made itself.
 *
 * `runAtsV2Claim` routed every listing error through the demoted board's weekly
 * recovery slot, including errors that never reached the board: a circuit
 * block, a provider budget refusal, a 429. The board was already parked or
 * blacklisted from some earlier judgement, so the batch inherited that board's
 * next weekly check date -- roughly six and a half days out -- for a circuit
 * whose own reopen time was six hours. On 2026-09-02 that held 4,593 listing
 * batches, 2,717 of them Workday, whose daily intake fell 47,475 -> 8,528 over
 * the same window.
 *
 * The dispatcher is fixed prospectively; batches already holding a far-future
 * `nextAcquireAt` keep it until that date arrives, so they need moving back.
 *
 * What this changes: `nextAcquireAt` only, and only ever to an earlier time. A
 * batch behind a still-open circuit is moved to that circuit's own reopen
 * instant rather than to now, so this releases work without aiming a thundering
 * herd at a platform that is still refusing us.
 *
 * What it does not change: no batch status, no acquisition phase, no board
 * status, no cursor or offset. It creates, deletes and modifies no Job row and
 * never touches scoring. Rows under a live claim are left to their holder.
 *
 * Dry run by default. Pass --apply to write.
 */
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

/**
 * Errors that mean "we declined to make this call", not "the board failed".
 * Mirrors `isAtsBoardLevelFailure`, which is the authority on that distinction;
 * this is a text test because it runs against the error already stored on the
 * row, long after the error object itself is gone.
 */
const PIPELINE_IMPOSED = /deferred by|circuit_open|rate.?limited this request/i;

/**
 * Only rows parked well beyond an ordinary backoff are candidates. The routine
 * retry is 15 minutes and the longest legitimate circuit is six hours, so a
 * batch more than twelve hours out is there because of the weekly slot.
 */
const MIN_DEFERRAL_HOURS = 12;

async function main() {
  const now = new Date();
  const threshold = new Date(now.getTime() + MIN_DEFERRAL_HOURS * 3_600_000);

  const parked = await prisma.atsIngestionBatch.findMany({
    where: {
      writerMode: 'v2',
      acquisitionPhase: 'listing',
      status: { in: ['fetching', 'partial'] },
      nextAcquireAt: { gt: threshold },
      // A live claim owns the row; leave it to its holder.
      OR: [
        { acquisitionClaimToken: null },
        { acquisitionLeaseExpiresAt: { lte: now } },
      ],
    },
    select: {
      id: true, slug: true, platform: true, lastError: true, nextAcquireAt: true,
    },
  });

  const candidates = parked.filter((batch) => PIPELINE_IMPOSED.test(batch.lastError || ''));

  // Where a platform is still refusing us, release to its own reopen instant
  // instead of to now. An open circuit knows when it lifts; that is the
  // earliest moment the work can actually succeed.
  const circuits = await prisma.providerCircuit.findMany({
    where: { state: 'open', openUntil: { gt: now } },
    select: { provider: true, openUntil: true },
  });
  const reopenAt = new Map(
    circuits.map((circuit) => [circuit.provider, circuit.openUntil as Date]),
  );

  const releaseFor = (platform: string): Date => {
    const open = reopenAt.get(`ATS-${platform}`);
    return open && open.getTime() > now.getTime() ? open : now;
  };

  const byPlatform = new Map<string, { batches: number; heldHours: number }>();
  for (const batch of candidates) {
    const entry = byPlatform.get(batch.platform) || { batches: 0, heldHours: 0 };
    entry.batches += 1;
    entry.heldHours += batch.nextAcquireAt
      ? (batch.nextAcquireAt.getTime() - now.getTime()) / 3_600_000
      : 0;
    byPlatform.set(batch.platform, entry);
  }
  const platforms = [...byPlatform.entries()]
    .map(([platform, entry]) => ({
      platform,
      batches: entry.batches,
      avgHoursHeld: Math.round(entry.heldHours / entry.batches),
      releasedTo: releaseFor(platform).toISOString(),
    }))
    .sort((left, right) => right.batches - left.batches);

  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      farFutureListingBatches: parked.length,
      releasable: candidates.length,
      platforms,
    }, null, 2));
    return;
  }

  let released = 0;
  for (const batch of candidates) {
    const target = releaseFor(batch.platform);
    // Guarded on the value read above: a batch a worker has since claimed and
    // rescheduled is left alone rather than pulled out from under it. Only ever
    // moves a retry earlier.
    const result = await prisma.atsIngestionBatch.updateMany({
      where: {
        id: batch.id,
        nextAcquireAt: batch.nextAcquireAt,
        acquisitionPhase: 'listing',
      },
      data: { nextAcquireAt: target },
    });
    released += result.count;
  }

  console.log(JSON.stringify({
    apply: true,
    releasable: candidates.length,
    released,
    skippedRacedRows: candidates.length - released,
    platforms,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
