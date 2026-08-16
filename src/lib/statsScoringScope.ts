import { Prisma } from '@prisma/client';

/**
 * The "which score events currently count" definition, shared by every
 * calibration metric on the stats dashboard.
 *
 * This deliberately mirrors the v2 branch of `resolveScoreAuthority` in
 * `scoreAuthority.ts`. It must not drift from it: if the dashboard scopes
 * scores differently from the authority that decides what the rest of the app
 * shows, the dashboard is reporting on a population the user never sees.
 *
 * History worth keeping: this used to INNER JOIN `JobScoringArtifact` on
 * `JobScoreEvent.cleanedJdArtifactId`. That was the v1 binding. The v2 launch
 * (commit 39eb409) replaced it with an `AimFactualExtraction` binding and
 * started writing `cleanedJdArtifactId: null` on every event
 * (`scoringImport.ts`), which silently reduced every calibration query to zero
 * rows — the join matched only three surviving v1 events, and those three
 * carried a superseded input-versions hash, so the two filters were disjoint.
 * Every number in the Calibration section read 0 for reasons that had nothing
 * to do with scoring.
 */
export function currentScoreScope(input: {
  aimInputVersionsHash: string;
  experienceInputVersionsHash: string;
}): Prisma.Sql {
  return Prisma.sql`
    ranked_aim AS (
      SELECT
        event.*,
        ROW_NUMBER() OVER (
          PARTITION BY event."jobId"
          ORDER BY event."createdAt" DESC, event.id DESC
        ) AS rank
      FROM "JobScoreEvent" event
      WHERE event."evaluationType" = 'aim_fit'
    ),
    current_aim AS (
      SELECT aim.*
      FROM ranked_aim aim
      -- v2 binds Aim to its factual extraction by id, and the extraction must
      -- still be fresh. This deliberately does not compare sourceJdHash: v2
      -- inputBindings carry extractionIdentity / sourceIdentity instead, and
      -- only the three retired v1 rows ever had a sourceJdHash key, so
      -- comparing it matched nothing at all.
      JOIN "AimFactualExtraction" extraction
        ON extraction.id = aim."aimFactualExtractionId"
       AND extraction."staleAt" IS NULL
      WHERE aim.rank = 1
        AND aim."staleAt" IS NULL
        AND aim."schemaVersion" = 'career-dashboard-aim-result-v2'
        AND aim."inputBindings"->>'globalInputVersionsHash' = ${input.aimInputVersionsHash}
    ),
    ranked_experience AS (
      SELECT
        event.*,
        ROW_NUMBER() OVER (
          PARTITION BY event."jobId"
          ORDER BY event."createdAt" DESC, event.id DESC
        ) AS rank
      FROM "JobScoreEvent" event
      WHERE event."evaluationType" = 'experience_fit'
    ),
    current_experience AS (
      SELECT experience.*
      FROM ranked_experience experience
      JOIN current_aim aim
        ON aim."jobId" = experience."jobId"
       AND aim.passed = true
       AND experience."sourceAimEventId" = aim.id
       AND experience."aimFactualExtractionId" = aim."aimFactualExtractionId"
       AND experience."inputBindings"->>'aimSemanticResultHash' = aim."semanticResultHash"
      WHERE experience.rank = 1
        AND experience."staleAt" IS NULL
        AND experience."schemaVersion" = 'career-dashboard-experience-result-v2'
        AND experience."inputBindings"->>'globalInputVersionsHash' = ${input.experienceInputVersionsHash}
    )
  `;
}
