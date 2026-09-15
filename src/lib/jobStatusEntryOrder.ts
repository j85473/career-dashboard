import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from './prisma';
import { statusEntryHistoryValue } from './jobSort';

type StatusEntryOrderClient = Pick<PrismaClient, 'job' | '$queryRaw'>;

export type StatusEntryQueuePage = {
  ids: string[];
  total: number;
};

function statusEntryCandidateWhere(dashboardStatus: string, historyStatus: string): Prisma.Sql {
  if (dashboardStatus === 'local_dismissed') {
    return Prisma.sql`job.status = 'dismissed' AND job."aimFitScore" IS NULL`;
  }
  if (dashboardStatus === 'dismissed') {
    return Prisma.sql`job.status = 'dismissed' AND job."aimFitScore" IS NOT NULL`;
  }
  return Prisma.sql`job.status = ${historyStatus}`;
}

/**
 * Paginate a lifecycle board by the latest time each job entered that board's
 * current status. A later edit must not make an old application or dismissal
 * look new. updatedAt is used only for rows that predate status-history
 * tracking; createdAt is ingestion time and never participates.
 */
export async function statusEntryOrderedPage(
  where: Prisma.JobWhereInput,
  dashboardStatus: string,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
  client: StatusEntryOrderClient = prisma,
  searchCandidateIds?: readonly string[],
): Promise<StatusEntryQueuePage> {
  const historyStatus = statusEntryHistoryValue(dashboardStatus);
  if (!historyStatus) throw new Error(`Status ${dashboardStatus} does not use lifecycle-entry ordering.`);
  const order = direction === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (searchCandidateIds?.length === 0) return { ids: [], total: 0 };
  const candidateWhere = searchCandidateIds
    ? Prisma.sql`job.id IN (${Prisma.join(searchCandidateIds)})`
    : statusEntryCandidateWhere(dashboardStatus, historyStatus);

  const [ordered, total] = await Promise.all([
    client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT job.id
      FROM "Job" job
      WHERE ${candidateWhere}
      ORDER BY COALESCE(
        (
          SELECT MAX(history."createdAt")
          FROM "JobStatusHistory" history
          WHERE history."jobId" = job.id
            AND history.status = ${historyStatus}
        ),
        job."updatedAt"
      ) ${order},
      job.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    searchCandidateIds
      ? Promise.resolve(searchCandidateIds.length)
      : client.job.count({ where }),
  ]);

  return { ids: ordered.map((row) => row.id), total };
}
