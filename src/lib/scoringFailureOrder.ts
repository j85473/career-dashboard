import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from './prisma';

type FailureOrderClient = Pick<PrismaClient, 'job' | '$queryRaw'>;

export type FailureQueuePage = {
  ids: string[];
  total: number;
};

/**
 * Paginate a failed-work queue by when scoring actually entered the failed
 * state. Job.createdAt is ingestion time and must never participate. The
 * immutable status history is authoritative; current Aim failure receipts
 * cover receipt-authoritative safe failures. updatedAt is only a fallback for
 * legacy rows that failed before status-history tracking began.
 */
export async function scoringFailureOrderedPage(
  where: Prisma.JobWhereInput,
  currentAimSuppressedJobIds: readonly string[],
  limit: number,
  offset: number,
  client: FailureOrderClient = prisma,
): Promise<FailureQueuePage> {
  const candidates = await client.job.findMany({ where, select: { id: true } });
  const candidateIds = candidates.map((candidate) => candidate.id);
  if (candidateIds.length === 0) return { ids: [], total: 0 };

  const candidateIdSet = new Set(candidateIds);
  const currentSuppressionIds = currentAimSuppressedJobIds.filter((id) => candidateIdSet.has(id));
  const currentAimFailureAt = currentSuppressionIds.length > 0
    ? Prisma.sql`(
        SELECT MAX(receipt."createdAt")
        FROM "AimScoringFailureReceipt" receipt
        WHERE receipt."jobId" = job.id
          AND receipt."suppressionActive" = true
          AND receipt."clearedAt" IS NULL
          AND job.id IN (${Prisma.join(currentSuppressionIds)})
      )`
    : Prisma.sql`NULL::timestamp`;

  const ordered = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT job.id
    FROM "Job" job
    WHERE job.id IN (${Prisma.join(candidateIds)})
    ORDER BY COALESCE(
      GREATEST(
        (
          SELECT MAX(history."createdAt")
          FROM "JobScoringStatusHistory" history
          WHERE history."jobId" = job.id
            AND history."scoringStatus" = 'failed'
        ),
        ${currentAimFailureAt}
      ),
      job."updatedAt"
    ) DESC,
    job.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { ids: ordered.map((row) => row.id), total: candidateIds.length };
}
