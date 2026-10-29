import type { PrismaClient } from './prismaClient';
import { prisma } from './prisma';
import { withApplicationDates } from './jobApplicationDate';
import { consolidatedIntoJobId } from './jobConsolidationReason';
import { isAppliedDuplicateAuthorityEvidence } from './appliedDuplicatePolicy';

type ContextStore = Pick<PrismaClient, 'job' | 'jobStatusHistory'>;
type ContextJob = { id: string; status: string; passReason?: string | null };

/** Read only: expose the saved card a copy was combined into, including its application. */
export async function withJobApplicationContext<T extends ContextJob>(
  jobs: readonly T[],
  store: ContextStore = prisma,
) {
  const datedJobs = await withApplicationDates(jobs, store);
  const targets = new Map<string, {
    id: string; title: string; company: string; employer: string | null;
    status: string; passReason: string | null;
  }>();
  let pending = [...new Set(jobs.map(job => consolidatedIntoJobId(job.passReason))
    .filter((id): id is string => Boolean(id)))];
  // Follow a bounded chain if the original survivor was later combined again.
  for (let depth = 0; pending.length && depth < 5; depth++) {
    const rows = await store.job.findMany({
      where: { id: { in: pending } },
      select: { id: true, title: true, company: true, employer: true, status: true, passReason: true },
    });
    for (const row of rows) targets.set(row.id, row);
    pending = [...new Set(rows.map(row => consolidatedIntoJobId(row.passReason))
      .filter((id): id is string => typeof id === 'string' && !targets.has(id)))];
  }
  const datedTargets = new Map((await withApplicationDates([...targets.values()], store))
    .map(target => [target.id, target]));
  return datedJobs.map(job => {
    let id = consolidatedIntoJobId(job.passReason);
    const visited = new Set([job.id]);
    while (id && !visited.has(id)) {
      visited.add(id);
      const target = datedTargets.get(id);
      if (!target) break;
      const next = consolidatedIntoJobId(target.passReason);
      if (!next) return { ...job, combinedInto: {
        id: target.id, title: target.title, company: target.employer || target.company,
        status: target.status, appliedAt: target.appliedAt,
        alreadyApplied: isAppliedDuplicateAuthorityEvidence(target),
      } };
      id = next;
    }
    return { ...job, combinedInto: null };
  });
}
