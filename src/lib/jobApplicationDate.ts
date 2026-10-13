import type { PrismaClient } from '@prisma/client';

import { prisma } from './prisma';

type ApplicationHistory = { status: string; createdAt: Date };
type ApplicationDateStore = Pick<PrismaClient, 'jobStatusHistory'>;

/** Keep the original Applied event through interview and back-to-Applied transitions. */
export function applicationDateFromHistory(historiesNewestFirst: readonly ApplicationHistory[]): Date | null {
  let appliedAt: Date | null = null;
  for (const history of historiesNewestFirst) {
    if (history.status !== 'applied' && history.status !== 'interviewing') break;
    if (history.status === 'applied') appliedAt = history.createdAt;
  }
  // A last edit or an interview event cannot establish an application date.
  return appliedAt;
}

/** Read history once for the active application cards on this page; never write jobs or scores. */
export async function withApplicationDates<T extends { id: string; status: string }>(
  jobs: readonly T[],
  store: ApplicationDateStore = prisma,
): Promise<Array<T & { appliedAt: Date | null }>> {
  const ids = jobs.filter((job) => job.status === 'applied' || job.status === 'interviewing')
    .map((job) => job.id);
  const histories = ids.length === 0 ? [] : await store.jobStatusHistory.findMany({
    where: { jobId: { in: ids } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, status: true, createdAt: true },
  });
  const byJob = new Map<string, ApplicationHistory[]>();
  for (const history of histories) {
    const entries = byJob.get(history.jobId) || [];
    entries.push(history);
    byJob.set(history.jobId, entries);
  }
  return jobs.map((job) => ({
    ...job,
    appliedAt: job.status === 'applied' || job.status === 'interviewing'
      ? applicationDateFromHistory(byJob.get(job.id) || []) : null,
  }));
}
