import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from './prisma';

type AppliedOrderClient = Pick<PrismaClient, 'job' | '$queryRaw'>;

export type AppliedJobPage = {
  ids: string[];
  total: number;
};

/**
 * Paginate the Applied log by the latest time each job was explicitly marked
 * Applied. Later card edits cannot make an old application appear new.
 * updatedAt is only a compatibility fallback for rows that predate status
 * history tracking.
 */
export async function appliedJobOrderedPage(
  where: Prisma.JobWhereInput,
  limit: number,
  offset: number,
  client: AppliedOrderClient = prisma,
  searchCandidateIds?: readonly string[],
): Promise<AppliedJobPage> {
  if (searchCandidateIds?.length === 0) return { ids: [], total: 0 };
  const candidateWhere = searchCandidateIds
    ? Prisma.sql`job.id IN (${Prisma.join(searchCandidateIds)})`
    : Prisma.sql`job.status = 'applied'`;

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
            AND history.status = 'applied'
        ),
        job."updatedAt"
      ) DESC,
      job.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    searchCandidateIds
      ? Promise.resolve(searchCandidateIds.length)
      : client.job.count({ where }),
  ]);

  return { ids: ordered.map((row) => row.id), total };
}
