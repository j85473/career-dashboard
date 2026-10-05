import { Prisma } from '@prisma/client';
import { DISCOVERABLE_ATS_PLATFORM_BY_LABEL } from './atsBoardDiscovery';

/**
 * Only release the old one-day discovery hold in a named, successful audit.
 * Receipt absence protects attempts whose compatibility timestamps lag behind.
 * Keep this predicate shared between preview and the atomic update.
 */
export function firstCollectionCatchupQuery(runId: string, apply: boolean): Prisma.Sql {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)) {
    throw new Error('A valid --run-id UUID is required');
  }
  const platforms = [...new Set(Object.values(DISCOVERABLE_ATS_PLATFORM_BY_LABEL))];
  const eligible = Prisma.sql`
    -- Daily contacts have a date-leading index; scanning them per board is
    -- expensive. Materialize identities once, along with permanent tombstones.
    WITH contacts AS MATERIALIZED (
      SELECT DISTINCT slug, platform FROM "AtsEndpointDailyContactReceipt"
    ), retirements AS MATERIALIZED (
      SELECT LOWER(slug) AS slug, platform FROM "AtsCompany"
      WHERE status = 'excluded'
        AND COALESCE(TRIM("excludedReason"), '') !~* '^same board as .+ with different capitals'
    )
    SELECT board.slug, board.platform, board."nextCheckDate" AS "previousNextCheckDate"
    FROM "AtsCompany" board
    WHERE board.status = 'active'
      AND board.platform IN (${Prisma.join(platforms)})
      AND board."excludedAt" IS NULL AND board."excludedReason" IS NULL
      AND board."failCount" = 0 AND board."retryCount" = 0
      AND board."lastCheckedAt" IS NULL AND board."lastAttemptedAt" IS NULL
      AND board."lastRespondedAt" IS NULL AND board."lastSynchronizedAt" IS NULL
      AND board."lastProcessedAt" IS NULL
      AND board."nextCheckDate" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      AND board."nextCheckDate" - board."discoveredAt"
        BETWEEN INTERVAL '23 hours 59 minutes' AND INTERVAL '24 hours 1 minute'
      AND EXISTS (
        SELECT 1 FROM "AtsDiscoveryAuditCandidate" candidate
        WHERE candidate."runId" = ${runId} AND candidate.status = 'active'
          AND candidate.platform = board.platform AND candidate.slug = board.slug
      )
      AND NOT EXISTS (SELECT 1 FROM "AtsBoardCheckAttempt" attempt
        WHERE attempt.slug = board.slug AND attempt.platform = board.platform)
      AND NOT EXISTS (SELECT 1 FROM "AtsIngestionBatch" batch
        WHERE batch.slug = board.slug AND batch.platform = board.platform)
      AND NOT EXISTS (SELECT 1 FROM "AtsEndpointSweepReceipt" sweep
        WHERE sweep.slug = board.slug AND sweep.platform = board.platform)
      AND NOT EXISTS (SELECT 1 FROM contacts contact
        WHERE contact.slug = board.slug AND contact.platform = board.platform)
      AND NOT EXISTS (
        SELECT 1 FROM retirements retired
        WHERE retired.platform = board.platform AND retired.slug = LOWER(board.slug)
      )
    ${apply ? Prisma.sql`FOR UPDATE OF board SKIP LOCKED` : Prisma.empty}
  `;
  return apply ? Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    UPDATE "AtsCompany" board
    SET "nextCheckDate" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    FROM eligible
    WHERE board.slug = eligible.slug AND board.platform = eligible.platform
    RETURNING board.slug, board.platform, eligible."previousNextCheckDate"
  ` : eligible;
}
