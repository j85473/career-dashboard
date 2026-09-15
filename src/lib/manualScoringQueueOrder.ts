import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from './prisma';

export type ManualScoringQueueTab = 'aim_fit' | 'experience_fit';

type ManualScoringOrderClient = Pick<PrismaClient, 'job' | '$queryRaw'>;

export type ManualScoringQueuePage = {
  ids: string[];
  total: number;
};

export function isManualScoringQueueTab(logTab: string): logTab is ManualScoringQueueTab {
  return logTab === 'aim_fit' || logTab === 'experience_fit';
}

/**
 * Apply the fixed, lexicographic priority for the two manual-scoring queues.
 * The stage score always wins; the time the job entered that stage breaks an
 * equal-score tie. Job.createdAt is ingestion time and never participates.
 *
 * Aim entry is the latest completed local-scoring transition. Experience
 * entry is the latest imported Aim result, which is what makes the job ready
 * for Experience scoring. updatedAt is only a fallback for rows that predate
 * those append-only histories.
 */
export async function manualScoringCombinedOrderedPage(
  where: Prisma.JobWhereInput,
  logTab: ManualScoringQueueTab,
  limit: number,
  offset: number,
  client: ManualScoringOrderClient = prisma,
): Promise<ManualScoringQueuePage> {
  const candidates = await client.job.findMany({ where, select: { id: true } });
  const candidateIds = candidates.map((candidate) => candidate.id);
  if (candidateIds.length === 0) return { ids: [], total: 0 };

  const ordered = logTab === 'aim_fit'
    ? await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job.id
        FROM "Job" job
        WHERE job.id IN (${Prisma.join(candidateIds)})
        ORDER BY job."fitScore" DESC NULLS LAST,
          COALESCE(
            (
              SELECT MAX(history."createdAt")
              FROM "JobScoringStatusHistory" history
              WHERE history."jobId" = job.id
                AND history."scoringStatus" = 'scored'
            ),
            job."updatedAt"
          ) DESC,
          job.id ASC
        LIMIT ${limit} OFFSET ${offset}
      `)
    : await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job.id
        FROM "Job" job
        LEFT JOIN LATERAL (
          SELECT event."aimFitScore", event."createdAt"
          FROM "JobScoreEvent" event
          WHERE event."jobId" = job.id
            AND event."evaluationType" = 'aim_fit'
          ORDER BY event."createdAt" DESC, event.id DESC
          LIMIT 1
        ) latest_aim ON true
        WHERE job.id IN (${Prisma.join(candidateIds)})
        ORDER BY COALESCE(latest_aim."aimFitScore", job."aimFitScore") DESC NULLS LAST,
          COALESCE(latest_aim."createdAt", job."updatedAt") DESC,
          job.id ASC
        LIMIT ${limit} OFFSET ${offset}
      `);

  return { ids: ordered.map((row) => row.id), total: candidateIds.length };
}
