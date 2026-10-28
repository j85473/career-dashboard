import { Prisma, type PrismaClient } from './prismaClient';

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
 * current status. Applied instead uses the original application date in the
 * current Applied/Interviewing run, matching the date displayed on its card.
 * Other boards retain updatedAt for rows that predate status-history tracking.
 * createdAt is ingestion time and never participates.
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

  // Archived and unscored-dismissal boards each contain millions of jobs.
  // Aggregate their history instead of doing an index lookup for every Job
  // before returning even the first page. Smaller and search-scoped boards
  // retain the selective per-job lookup.
  const groupedHistory = (dashboardStatus === 'archived' || dashboardStatus === 'local_dismissed')
    && !searchCandidateIds;
  const historyJoin = groupedHistory ? Prisma.sql`
    LEFT JOIN (
      SELECT history."jobId", MAX(history."createdAt") AS "enteredAt"
      FROM "JobStatusHistory" history
      WHERE history.status = ${historyStatus}
      GROUP BY history."jobId"
    ) history ON history."jobId" = job.id
  ` : Prisma.empty;
  // Match applicationDateFromHistory: returning from Interviewing or repeating
  // Applied preserves the first Applied event, but a lifecycle break starts a
  // new application. Compare IDs too, matching the display's history tie order.
  const applicationDate = Prisma.sql`(
    SELECT MIN(history."createdAt")
    FROM "JobStatusHistory" history
    WHERE history."jobId" = job.id
      AND history.status = 'applied'
      AND NOT EXISTS (
        SELECT 1 FROM "JobStatusHistory" boundary
        WHERE boundary."jobId" = job.id
          AND boundary.status NOT IN ('applied', 'interviewing')
          AND (boundary."createdAt", boundary.id) > (history."createdAt", history.id)
      )
  )`;
  const enteredAt = groupedHistory ? Prisma.sql`history."enteredAt"` : Prisma.sql`(
    SELECT MAX(history."createdAt")
    FROM "JobStatusHistory" history
    WHERE history."jobId" = job.id
      AND history.status = ${historyStatus}
  )`;
  // An unknown application date stays undated and follows dated applications;
  // a recent edit must never make it look like a new application.
  const sortDate = dashboardStatus === 'applied'
    ? applicationDate
    : Prisma.sql`COALESCE(${enteredAt}, job."updatedAt")`;

  const [ordered, total] = await Promise.all([
    client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT job.id
      FROM "Job" job
      ${historyJoin}
      WHERE ${candidateWhere}
      ORDER BY ${sortDate} ${order} NULLS LAST,
      job.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    searchCandidateIds
      ? Promise.resolve(searchCandidateIds.length)
      : client.job.count({ where }),
  ]);

  return { ids: ordered.map((row) => row.id), total };
}
