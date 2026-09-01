import { createHash } from 'node:crypto';

import { prisma } from '../src/lib/prisma';

/**
 * Close legacy ATS batches that no writer can ever finish.
 *
 * A legacy batch that holds no lease, no claim, and no durable listing work is
 * unreachable: the acquisition loop only resumes batches it can claim, and
 * `convertLegacyAtsBatchToV2` refuses one with nothing to convert. The board is
 * also never promoted to v2, because `promoteDrainedLegacyBoardsToV2` skips any
 * board that still has an active batch. The pair deadlocks, and the batch keeps
 * counting against the cutover snapshot forever.
 *
 * Only rows with zero recorded work are eligible, so this abandons nothing that
 * was acquired: no job, score, observation, or payload is read or changed. The
 * board itself is untouched and returns on its next rotation slot.
 *
 * Dry run by default; `--apply` requires the hash from a fresh preview.
 */

const APPLY = process.argv.includes('--apply');
const REASON = 'Operator-closed orphaned legacy ATS batch with no durable work.';

const ACTIVE_STATUSES = ['fetching', 'partial', 'synchronized', 'queued', 'processing'] as const;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

type Candidate = {
  id: string;
  slug: string;
  platform: string;
  status: string;
  boardEngine: string;
};

function selectionHash(ids: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ ids: [...ids].sort(), reason: REASON }))
    .digest('hex');
}

async function candidates(): Promise<Candidate[]> {
  return prisma.$queryRawUnsafe<Candidate[]>(`
    SELECT batch.id, batch.slug, batch.platform, batch.status,
           board."acquisitionEngine" AS "boardEngine"
      FROM "AtsIngestionBatch" batch
      JOIN "AtsCompany" board
        ON board.slug = batch.slug AND board.platform = batch.platform
     WHERE batch."writerMode" = 'legacy'
       AND batch.status = ANY($1::text[])
       AND batch."leaseToken" IS NULL
       AND batch."acquisitionClaimToken" IS NULL
       AND batch."jobCount" = 0
       AND COALESCE(batch.payload::text, '[]') IN ('[]', 'null', '')
       AND batch."listingOffset" = 0
       AND batch."canonicalOccurrenceCount" = 0
       AND NOT EXISTS (
             SELECT 1 FROM "AtsIngestionItem" item WHERE item."batchId" = batch.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM "AtsIngestionSegment" seg WHERE seg."batchId" = batch.id
           )
     ORDER BY batch.id ASC
  `, ACTIVE_STATUSES as unknown as string[]);
}

async function main(): Promise<void> {
  const rows = await candidates();
  const hash = selectionHash(rows.map((row) => row.id));
  console.log(JSON.stringify({
    apply: false,
    selected: rows.length,
    candidates: rows,
    selectionHash: hash,
  }, null, 2));
  if (!APPLY) return;

  const expected = argument('--selection-hash');
  if (expected !== hash) {
    throw new Error('Selection hash mismatch; rerun the preview against current state.');
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(912837466)`;
    const current = await candidates();
    if (selectionHash(current.map((row) => row.id)) !== expected) {
      throw new Error('Selection changed before the transaction acquired authority.');
    }
    // A legacy batch on a board that has moved to v2 cannot take a lifecycle
    // write at all; those need conversion, not closure. Refuse rather than
    // trip the guard mid-transaction.
    const migrated = current.filter((row) => row.boardEngine !== 'legacy');
    if (migrated.length > 0) {
      throw new Error(`Refusing batches whose board left the legacy engine: ${
        migrated.map((row) => `${row.platform}/${row.slug}`).join(', ')}`);
    }
    const ids = current.map((row) => row.id);
    if (ids.length === 0) return { closed: 0, sweepReceipts: 0 };
    const now = new Date();
    const closed = await tx.atsIngestionBatch.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'operator_abandoned',
        acquisitionPhase: 'operator_abandoned',
        operatorResetAt: now,
        operatorResetReason: REASON,
        lastError: REASON,
        nextAcquireAt: null,
      },
    });
    const sweeps = await tx.atsEndpointSweepReceipt.updateMany({
      where: { batchId: { in: ids }, state: { notIn: ['failed', 'succeeded'] } },
      data: { state: 'failed', outcome: 'operator_closed_orphan' },
    });
    return { closed: closed.count, sweepReceipts: sweeps.count };
  });

  console.log(JSON.stringify({ apply: true, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
