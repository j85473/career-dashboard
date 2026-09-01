import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import {
  ATS_JOB_ENRICHMENT_KEY,
  ATS_JOB_ENRICHMENT_VERSION,
  ATS_OPERATOR_RESET_ABANDONED_REASON,
} from '../src/lib/atsJobEnrichment';
import { withProviderTransactionRetry } from '../src/lib/ingestionControl';
import { prisma } from '../src/lib/prisma';

const RESET_REASON = 'Operator-authorized fresh weekly rotation reset on 2026-08-31.';

type ResetBatch = {
  id: string;
  acquisitionPhase: string;
  canonicalOccurrenceCount: number;
  terminalItemCount: number;
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function selectionHash(batchIds: string[], resumeAt: Date): string {
  return createHash('sha256').update(JSON.stringify({
    batchIds: [...batchIds].sort(),
    resumeAt: resumeAt.toISOString(),
    resetReason: RESET_REASON,
  })).digest('hex');
}

async function selectedBatches(): Promise<ResetBatch[]> {
  return prisma.atsIngestionBatch.findMany({
    where: {
      writerMode: 'v2',
      status: { in: ['fetching', 'partial'] },
      acquisitionPhase: { in: ['listing', 'compaction', 'enrichment', 'sealing'] },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      acquisitionPhase: true,
      canonicalOccurrenceCount: true,
      terminalItemCount: true,
    },
  });
}

async function main(): Promise<void> {
  const resumeValue = argument('--resume-at');
  if (!resumeValue) throw new Error('--resume-at is required.');
  const resumeAt = new Date(resumeValue);
  if (!Number.isFinite(resumeAt.getTime()) || resumeAt <= new Date()) {
    throw new Error('--resume-at must be a valid future instant.');
  }
  const batches = await selectedBatches();
  const hash = selectionHash(batches.map((batch) => batch.id), resumeAt);
  const listingBatchIds = batches
    .filter((batch) => ['listing', 'compaction'].includes(batch.acquisitionPhase))
    .map((batch) => batch.id);
  const drainBatchIds = batches
    .filter((batch) => ['enrichment', 'sealing'].includes(batch.acquisitionPhase))
    .map((batch) => batch.id);
  const pendingItems = batches.reduce(
    (sum, batch) => sum + Math.max(0, batch.canonicalOccurrenceCount - batch.terminalItemCount),
    0,
  );
  const preview = {
    resumeAt: resumeAt.toISOString(),
    selectedBatches: batches.length,
    listingBatchesAbandoned: listingBatchIds.length,
    completedResultBatchesRetained: drainBatchIds.length,
    unfinishedDetailItemsFiltered: pendingItems,
    completedItemsRetained: batches.reduce((sum, batch) => sum + batch.terminalItemCount, 0),
    selectionHash: hash,
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!process.argv.includes('--apply')) return;
  const expectedHash = argument('--selection-hash');
  if (expectedHash !== hash) {
    throw new Error('Selection hash mismatch; rerun the preview against the current production state.');
  }

  const result = await withProviderTransactionRetry(() => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(912837466)`;
    await tx.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
    const current = await tx.atsIngestionBatch.findMany({
      where: {
        writerMode: 'v2',
        status: { in: ['fetching', 'partial'] },
        acquisitionPhase: { in: ['listing', 'compaction', 'enrichment', 'sealing'] },
      },
      orderBy: { id: 'asc' },
      select: { id: true, acquisitionPhase: true },
    });
    const currentHash = selectionHash(current.map((batch) => batch.id), resumeAt);
    if (currentHash !== expectedHash) throw new Error('Reset selection changed before the transaction acquired authority.');
    const currentListingIds = current
      .filter((batch) => ['listing', 'compaction'].includes(batch.acquisitionPhase))
      .map((batch) => batch.id);
    const currentDrainIds = current
      .filter((batch) => ['enrichment', 'sealing'].includes(batch.acquisitionPhase))
      .map((batch) => batch.id);
    const now = new Date();

    await tx.atsAcquisitionRuntimeGate.update({
      where: { id: 'global' },
      data: {
        admissionState: 'draining',
        admissionResumeAt: resumeAt,
        drainRequestedAt: now,
        cutoverReadyAt: null,
      },
    });
    await tx.atsAcquisitionWorkReceipt.updateMany({
      where: { batchId: { in: current.map((batch) => batch.id) }, finishedAt: null },
      data: {
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
        yieldReason: ATS_OPERATOR_RESET_ABANDONED_REASON,
        error: RESET_REASON,
      },
    });

    if (currentListingIds.length > 0) {
      await tx.atsIngestionBatch.updateMany({
        where: { id: { in: currentListingIds } },
        data: {
          status: 'operator_abandoned',
          acquisitionPhase: 'operator_abandoned',
          operatorResetAt: now,
          operatorResetReason: RESET_REASON,
          acquisitionClaimToken: null,
          acquisitionClaimOwner: null,
          acquisitionClaimFence: { increment: BigInt(1) },
          acquisitionHeartbeatAt: now,
          acquisitionLeaseExpiresAt: null,
          nextAcquireAt: null,
          lastError: RESET_REASON,
        },
      });
      await tx.atsEndpointSweepReceipt.updateMany({
        where: { batchId: { in: currentListingIds } },
        data: { state: 'failed', outcome: ATS_OPERATOR_RESET_ABANDONED_REASON },
      });
    }

    let abandonedItems = 0;
    if (currentDrainIds.length > 0) {
      abandonedItems = await tx.$executeRaw(Prisma.sql`
        UPDATE "AtsIngestionItem" item
           SET "enrichmentOverlay" = jsonb_build_object(
                 ${ATS_JOB_ENRICHMENT_KEY},
                 jsonb_build_object(
                   'version', ${ATS_JOB_ENRICHMENT_VERSION},
                   'status', 'unavailable',
                   'platform', batch."platform",
                   'detailSource', 'ATS-' || batch."platform" || ' Details',
                   'attempted', false,
                   'completedAt', to_char(${now}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'description', NULL,
                   'company', NULL,
                   'location', NULL,
                   'compensation', NULL,
                   'reason', ${ATS_OPERATOR_RESET_ABANDONED_REASON}
                 )
               ),
               "enrichmentVersion" = ${ATS_JOB_ENRICHMENT_VERSION},
               "enrichmentStatus" = 'terminal',
               "enrichmentReason" = ${ATS_OPERATOR_RESET_ABANDONED_REASON},
               "terminalAt" = ${now},
               "nextDetailAt" = NULL,
               "itemClaimToken" = NULL,
               "itemClaimOwner" = NULL,
               "itemClaimFence" = "itemClaimFence" + 1,
               "itemHeartbeatAt" = ${now},
               "itemLeaseExpiresAt" = NULL,
               "updatedAt" = ${now}
          FROM "AtsIngestionBatch" batch
         WHERE item."batchId" = batch."id"
           AND batch."id" IN (${Prisma.join(currentDrainIds)})
           AND item."ledgerGeneration" = batch."activeLedgerGeneration"
           AND item."enrichmentStatus" = 'pending'
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AtsIngestionBatch" batch
           SET "status" = 'reset_draining',
               "acquisitionPhase" = CASE
                 WHEN batch."canonicalOccurrenceCount" = (
                   SELECT COUNT(*) FROM "AtsIngestionItem" item
                    WHERE item."batchId" = batch."id"
                      AND item."ledgerGeneration" = batch."activeLedgerGeneration"
                      AND item."enrichmentStatus" = 'terminal'
                 ) THEN 'sealing'
                 ELSE 'enrichment'
               END,
               "terminalItemCount" = (
                 SELECT COUNT(*) FROM "AtsIngestionItem" item
                  WHERE item."batchId" = batch."id"
                    AND item."ledgerGeneration" = batch."activeLedgerGeneration"
                    AND item."enrichmentStatus" = 'terminal'
               ),
               "operatorResetAt" = ${now},
               "operatorResetReason" = ${RESET_REASON},
               "operatorResetAbandonedItems" = batch."canonicalOccurrenceCount" - batch."terminalItemCount",
               "acquisitionClaimToken" = NULL,
               "acquisitionClaimOwner" = NULL,
               "acquisitionClaimFence" = batch."acquisitionClaimFence" + 1,
               "acquisitionHeartbeatAt" = ${now},
               "acquisitionLeaseExpiresAt" = NULL,
               "nextAcquireAt" = ${now},
               "lastError" = NULL,
               "updatedAt" = ${now}
         WHERE batch."id" IN (${Prisma.join(currentDrainIds)})
      `);
    }

    const boardsRealigned = await tx.$executeRaw(Prisma.sql`
      WITH schedule AS (
        SELECT
          (${resumeAt}::timestamptz AT TIME ZONE 'America/Chicago')::date AS local_start,
          EXTRACT(DOW FROM (${resumeAt}::timestamptz AT TIME ZONE 'America/Chicago'))::integer AS start_day
      )
      UPDATE "AtsCompany" board
         SET "nextCheckDate" = (
               (
                 schedule.local_start
                 + (((board."checkDay" - schedule.start_day + 7) % 7) * INTERVAL '1 day')
                 + INTERVAL '1 minute'
               ) AT TIME ZONE 'America/Chicago'
             ) AT TIME ZONE 'UTC'
        FROM schedule
       WHERE board."acquisitionEngine" = 'v2'
         AND board."status" IN ('active', 'parked', 'blacklisted')
         AND board."checkDay" BETWEEN 0 AND 6
    `);
    return {
      listingBatchesAbandoned: currentListingIds.length,
      completedResultBatchesRetained: currentDrainIds.length,
      unfinishedDetailItemsFiltered: abandonedItems,
      boardsRealigned,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 30_000, timeout: 180_000 }));
  console.log(JSON.stringify({ applied: true, ...result, resumeAt: resumeAt.toISOString() }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
