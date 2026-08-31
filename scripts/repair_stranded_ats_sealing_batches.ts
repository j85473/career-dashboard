/**
 * Return v2 batches that sealed before their items were terminal to the
 * enrichment phase.
 *
 * `sealReadyAtsV2Segments` used to set `acquisitionPhase: 'sealing'` whenever a
 * seal pass did not complete, including when items were still pending. That was
 * a one-way trapdoor: the continuation quantum only terminalizes and enriches
 * while the batch reads 'enrichment', and both ledger writers no-op otherwise,
 * so the batch could never become terminal and never seal again.
 *
 * The writer is fixed prospectively, but batches already stranded need their
 * phase moved back. This only re-opens enrichment on work that is provably
 * incomplete (`terminalItemCount < canonicalOccurrenceCount`). It creates no
 * Job rows, publishes no segments, discards no sealed segment, and never
 * touches scoring.
 *
 * Dry run by default. Pass --apply to write.
 */
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const stranded = await prisma.atsIngestionBatch.findMany({
    where: {
      writerMode: 'v2',
      acquisitionPhase: 'sealing',
      status: { in: ['fetching', 'partial'] },
      // A live claim owns the row; leave it to its holder.
      OR: [
        { acquisitionClaimToken: null },
        { acquisitionLeaseExpiresAt: { lte: new Date() } },
      ],
    },
    select: {
      id: true,
      slug: true,
      platform: true,
      canonicalOccurrenceCount: true,
      terminalItemCount: true,
      sealedItemCount: true,
    },
  });
  const repairable = stranded.filter(
    (batch) => batch.terminalItemCount < batch.canonicalOccurrenceCount,
  );
  const pendingItems = repairable.reduce(
    (sum, batch) => sum + (batch.canonicalOccurrenceCount - batch.terminalItemCount),
    0,
  );

  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      sealingBatchesInspected: stranded.length,
      strandedBatches: repairable.length,
      pendingItemsToReopen: pendingItems,
      sample: repairable.slice(0, 5).map((batch) => ({
        slug: batch.slug,
        platform: batch.platform,
        terminal: batch.terminalItemCount,
        canonical: batch.canonicalOccurrenceCount,
      })),
    }, null, 2));
    return;
  }

  let repaired = 0;
  for (const batch of repairable) {
    // Re-check the guard inside the write so a batch that went terminal or got
    // claimed since the scan is left exactly as it is.
    const moved = await prisma.atsIngestionBatch.updateMany({
      where: {
        id: batch.id,
        writerMode: 'v2',
        acquisitionPhase: 'sealing',
        status: { in: ['fetching', 'partial'] },
        terminalItemCount: { lt: batch.canonicalOccurrenceCount },
        canonicalOccurrenceCount: batch.canonicalOccurrenceCount,
        OR: [
          { acquisitionClaimToken: null },
          { acquisitionLeaseExpiresAt: { lte: new Date() } },
        ],
      },
      data: { acquisitionPhase: 'enrichment', nextAcquireAt: null },
    });
    repaired += moved.count;
  }
  console.log(JSON.stringify({
    apply: true,
    sealingBatchesInspected: stranded.length,
    strandedBatches: repairable.length,
    repaired,
    pendingItemsReopened: pendingItems,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
