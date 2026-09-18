import type { Prisma } from '@prisma/client';

const APPLICATION_STATUSES = ['applied', 'interviewing'] as const;

type CompanyJobOrderStore = Pick<Prisma.TransactionClient, 'job'>;

/**
 * Keep active applications together at the front of an exact-company view,
 * then use the Dashboard's ordinary newest-first order within both groups.
 * Returning ids lets the route preserve its existing score-authority
 * projection without making that expensive work part of the ordering query.
 */
export async function companyJobOrderedPage(
  where: Prisma.JobWhereInput,
  limit: number,
  skip: number,
  store: CompanyJobOrderStore,
): Promise<{ ids: string[]; total: number }> {
  const applicationWhere: Prisma.JobWhereInput = {
    AND: [where, { status: { in: [...APPLICATION_STATUSES] } }],
  };
  const otherWhere: Prisma.JobWhereInput = {
    AND: [where, { status: { notIn: [...APPLICATION_STATUSES] } }],
  };
  const [applicationCount, total] = await Promise.all([
    store.job.count({ where: applicationWhere }),
    store.job.count({ where }),
  ]);

  const applicationTake = Math.min(limit, Math.max(0, applicationCount - skip));
  const otherTake = limit - applicationTake;
  const [applications, others] = await Promise.all([
    applicationTake > 0
      ? store.job.findMany({
        where: applicationWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take: applicationTake,
        select: { id: true },
      })
      : Promise.resolve([]),
    otherTake > 0
      ? store.job.findMany({
        where: otherWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: Math.max(0, skip - applicationCount),
        take: otherTake,
        select: { id: true },
      })
      : Promise.resolve([]),
  ]);

  return {
    ids: [...applications, ...others].map((job) => job.id),
    total,
  };
}
