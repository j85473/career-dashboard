import { prisma } from './prisma';

export const LOCAL_SCORING_LEASE_STALE_AFTER_MS = 15 * 60 * 1000;

export function staleLocalScoringLeaseCutoff(
  now: Date = new Date(),
  staleAfterMs = LOCAL_SCORING_LEASE_STALE_AFTER_MS,
): Date {
  return new Date(now.getTime() - staleAfterMs);
}

/**
 * Release only abandoned local-scoring claims. The lease token and `scoring`
 * state are written together by scoreJobs, so both must still be present and
 * stale before the job can safely return to the queued state.
 */
export async function recoverStaleLocalScoringLeases(
  now: Date = new Date(),
  client: Pick<typeof prisma, 'job'> = prisma,
): Promise<number> {
  const result = await client.job.updateMany({
    where: {
      batchJobId: { not: null },
      scoringStatus: 'scoring',
      updatedAt: { lt: staleLocalScoringLeaseCutoff(now) },
    },
    data: { batchJobId: null, scoringStatus: 'queued' },
  });
  return result.count;
}
