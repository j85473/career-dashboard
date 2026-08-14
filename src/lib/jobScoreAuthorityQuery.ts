import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import type { StagedScoreBundle } from '@/lib/scoreAuthority';
import { currentScoringInputVersions, eventInputBindingsCurrent } from '@/lib/scoringInputVersions';

export type LatestJobScoreEvent = {
  id: string;
  jobId: string;
  evaluationType: string;
  model: string;
  promptVersion: string;
  requestId: string | null;
  resultHash: string | null;
  policyVersion: string | null;
  schemaVersion: string | null;
  batchId: string | null;
  batchItemId: string | null;
  decisionCode: string | null;
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
  aimAssessments: Prisma.JsonValue | null;
  travelAssessment: Prisma.JsonValue | null;
  compensationAssessment: Prisma.JsonValue | null;
  inputBindings: Prisma.JsonValue | null;
  workerProvenance: Prisma.JsonValue | null;
  sourceAimEventId: string | null;
  cleanedJdArtifactId: string | null;
  aimFactualExtractionId: string | null;
  semanticResultHash: string | null;
  scoringIdentity: string | null;
  questionRegistryHash: string | null;
  scoringPolicyHash: string | null;
  resultBuilderSemanticVersion: string | null;
  lifecyclePriorStatus: string | null;
  lifecycleApplied: boolean | null;
  passed: boolean;
  staleAt: Date | null;
  staleReason: string | null;
  createdAt: Date;
};

export type LatestJobScoreBundle = StagedScoreBundle<LatestJobScoreEvent>;

/**
 * Returns exactly the newest standard/A-E event for each requested job. The
 * window ranks stale and nonstale rows together; callers decide authority only
 * after rank=1, so an older nonstale event can never be resurrected.
 */
export async function latestJobScoreEvents(
  jobIds: readonly string[],
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<Map<string, LatestJobScoreBundle>> {
  if (jobIds.length === 0) return new Map();

  const rows = await client.$queryRaw<Array<LatestJobScoreEvent & {
    family: string;
    artifactId: string | null;
    artifactHash: string | null;
    artifactStaleAt: Date | null;
    extractionId: string | null;
    extractionSourceJdHash: string | null;
    extractionStaleAt: Date | null;
  }>>(Prisma.sql`
    WITH ranked AS (
      SELECT
        e.*,
        CASE WHEN e."evaluationType" = 'aim_fit' THEN 'aim' WHEN e."evaluationType" = 'experience_fit' THEN 'experience' ELSE 'legacy' END AS family,
        ROW_NUMBER() OVER (
          PARTITION BY e."jobId", CASE WHEN e."evaluationType" = 'aim_fit' THEN 'aim' WHEN e."evaluationType" = 'experience_fit' THEN 'experience' ELSE 'legacy' END
          ORDER BY e."createdAt" DESC, e."id" DESC
        ) AS rank
      FROM "JobScoreEvent" e
      WHERE e."jobId" IN (${Prisma.join([...jobIds])})
        AND e."evaluationType" IN ('standard', 'ae_fit', 'aim_fit', 'experience_fit')
    )
    SELECT
      r."id", r."jobId", r."evaluationType", r."model", r."promptVersion", r."requestId", r."resultHash",
      r."policyVersion", r."schemaVersion", r."batchId", r."batchItemId", r."decisionCode",
      r."aimFitScore", r."experienceFitScore", r."travelScore", r."aimReason", r."experienceReason",
      r."domainMatch", r."requiredDomain", r."candidateDomain", r."qualificationBasis",
      r."mandatoryRequirementAssessments", r."aimAssessments", r."travelAssessment", r."compensationAssessment",
      r."inputBindings", r."workerProvenance", r."sourceAimEventId", r."cleanedJdArtifactId",
      r."aimFactualExtractionId", r."semanticResultHash", r."scoringIdentity", r."questionRegistryHash",
      r."scoringPolicyHash", r."resultBuilderSemanticVersion", r."lifecyclePriorStatus", r."lifecycleApplied",
      r."passed", r."staleAt", r."staleReason", r."createdAt", r.family,
      a.id AS "artifactId", a."contentHash" AS "artifactHash", a."staleAt" AS "artifactStaleAt",
      x.id AS "extractionId", x."sourceJdHash" AS "extractionSourceJdHash", x."staleAt" AS "extractionStaleAt"
    FROM ranked r
    LEFT JOIN "JobScoringArtifact" a ON a.id = r."cleanedJdArtifactId"
    LEFT JOIN "AimFactualExtraction" x ON x.id = r."aimFactualExtractionId"
    WHERE r.rank = 1
  `);
  const bundles = new Map<string, LatestJobScoreBundle>();
  const versions = currentScoringInputVersions();
  for (const row of rows) {
    const bundle = bundles.get(row.jobId) || { legacy: null, aim: null, experience: null, cleanedArtifact: null, aimExtraction: null };
    const event = {
      ...row,
      inputBindingsCurrent: row.family === 'aim'
        ? eventInputBindingsCurrent('aim', row.inputBindings, versions)
        : row.family === 'experience'
          ? eventInputBindingsCurrent('experience', row.inputBindings, versions)
          : true,
    };
    if (row.family === 'aim') {
      bundle.aim = event;
      bundle.cleanedArtifact = row.artifactId ? { id: row.artifactId, contentHash: row.artifactHash || '', staleAt: row.artifactStaleAt } : null;
      bundle.aimExtraction = row.extractionId && row.extractionSourceJdHash
        ? { id: row.extractionId, sourceJdHash: row.extractionSourceJdHash, staleAt: row.extractionStaleAt }
        : null;
    } else if (row.family === 'experience') bundle.experience = event;
    else bundle.legacy = event;
    bundles.set(row.jobId, bundle);
  }
  return bundles;
}
