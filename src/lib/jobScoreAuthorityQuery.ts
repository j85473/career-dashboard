import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

export type LatestJobScoreEvent = {
  id: string;
  jobId: string;
  evaluationType: string;
  model: string;
  promptVersion: string;
  requestId: string | null;
  aimFitScore: number | null;
  experienceFitScore: number | null;
  travelScore: number | null;
  aimReason: string | null;
  experienceReason: string | null;
  domainMatch: boolean | null;
  requiredDomain: string | null;
  candidateDomain: string | null;
  qualificationBasis: string | null;
  mandatoryRequirementAssessments: Prisma.JsonValue | null;
  passed: boolean;
  staleAt: Date | null;
  staleReason: string | null;
  createdAt: Date;
};

/**
 * Returns exactly the newest standard/A-E event for each requested job. The
 * window ranks stale and nonstale rows together; callers decide authority only
 * after rank=1, so an older nonstale event can never be resurrected.
 */
export async function latestJobScoreEvents(
  jobIds: readonly string[],
): Promise<Map<string, LatestJobScoreEvent>> {
  if (jobIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<LatestJobScoreEvent[]>(Prisma.sql`
    WITH ranked AS (
      SELECT
        "id",
        "jobId",
        "evaluationType",
        "model",
        "promptVersion",
        "requestId",
        "aimFitScore",
        "experienceFitScore",
        "travelScore",
        "aimReason",
        "experienceReason",
        "domainMatch",
        "requiredDomain",
        "candidateDomain",
        "qualificationBasis",
        "mandatoryRequirementAssessments",
        "passed",
        "staleAt",
        "staleReason",
        "createdAt",
        ROW_NUMBER() OVER (
          PARTITION BY "jobId"
          ORDER BY "createdAt" DESC, "id" DESC
        ) AS rank
      FROM "JobScoreEvent"
      WHERE "jobId" IN (${Prisma.join([...jobIds])})
        AND "evaluationType" IN ('standard', 'ae_fit')
    )
    SELECT
      "id",
      "jobId",
      "evaluationType",
      "model",
      "promptVersion",
      "requestId",
      "aimFitScore",
      "experienceFitScore",
      "travelScore",
      "aimReason",
      "experienceReason",
      "domainMatch",
      "requiredDomain",
      "candidateDomain",
      "qualificationBasis",
      "mandatoryRequirementAssessments",
      "passed",
      "staleAt",
      "staleReason",
      "createdAt"
    FROM ranked
    WHERE rank = 1
  `);

  return new Map(rows.map((row) => [row.jobId, row]));
}
