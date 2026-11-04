import type { Prisma, PrismaClient } from './prismaClient';
import { prisma } from './prisma';
import { compareInterviewJobs } from './jobInterviewSchedule';

export const jobInterviewSelect = { id: true, scheduledAt: true, label: true } as const;
export const jobInterviewsSelect = {
  select: jobInterviewSelect,
  orderBy: [{ scheduledAt: 'asc' as const }, { id: 'asc' as const }],
};

/** The small interview log is ordered across all matching cards before pagination. */
export async function interviewOrderedPage(
  where: Prisma.JobWhereInput,
  limit: number,
  offset: number,
  client: Pick<PrismaClient, 'job'> = prisma,
  now = Date.now(),
) {
  const jobs = await client.job.findMany({ where, select: { id: true, interviews: jobInterviewsSelect } });
  jobs.sort((a, b) => compareInterviewJobs(a, b, now));
  return { ids: jobs.slice(offset, offset + limit).map(job => job.id), total: jobs.length };
}
