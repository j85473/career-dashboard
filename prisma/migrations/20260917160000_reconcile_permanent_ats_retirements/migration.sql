-- A permanent retirement applies to the board identity, not one spelling of
-- that identity. Older discovery writers used case-sensitive primary keys and
-- could therefore recreate an active/parked/blacklisted capitalization variant
-- beside an excluded row. Reconcile those aliases once; the application guard
-- prevents them from returning afterward.

BEGIN;

SELECT pg_advisory_xact_lock(912837466);

CREATE TEMP TABLE "_PermanentAtsRetirementAliases" ON COMMIT DROP AS
WITH permanent AS (
  SELECT DISTINCT ON (platform, lower(slug))
         platform,
         lower(slug) AS normalized,
         slug AS "retiredSlug"
    FROM "AtsCompany"
   WHERE status = 'excluded'
     AND COALESCE(trim("excludedReason"), '') !~* '^same board as .+ with different capitals'
   ORDER BY platform, lower(slug), "excludedAt" NULLS LAST, slug
)
SELECT board.slug,
       board.platform,
       permanent."retiredSlug"
  FROM "AtsCompany" board
  JOIN permanent
    ON permanent.platform = board.platform
   AND permanent.normalized = lower(board.slug)
 WHERE board.status <> 'excluded';

-- Refuse before any lifecycle write if closing an outstanding alias batch
-- could strand acquired postings. Jobs already persisted are never in scope.
DO $$
DECLARE
  unsafe_batches integer;
BEGIN
  SELECT count(*)
    INTO unsafe_batches
    FROM "AtsIngestionBatch" batch
    JOIN "_PermanentAtsRetirementAliases" alias
      ON alias.slug = batch.slug
     AND alias.platform = batch.platform
   WHERE batch.status IN ('fetching', 'partial', 'synchronized')
     AND (
       batch."rawObservationCount" > 0
       OR batch."canonicalOccurrenceCount" > 0
       OR batch."compactedOccurrenceCount" > 0
       OR batch."terminalItemCount" > 0
       OR batch."sealedItemCount" > 0
       OR batch."publishedItemCount" > 0
       OR batch."jobCount" > 0
       OR batch."insertedCount" > 0
     );

  IF unsafe_batches > 0 THEN
    RAISE EXCEPTION
      'Permanent ATS retirement reconciliation refused: % outstanding alias batch(es) contain acquired work',
      unsafe_batches;
  END IF;
END $$;

CREATE TEMP TABLE "_PermanentAtsRetirementBatches" ON COMMIT DROP AS
SELECT batch.id
  FROM "AtsIngestionBatch" batch
  JOIN "_PermanentAtsRetirementAliases" alias
    ON alias.slug = batch.slug
   AND alias.platform = batch.platform
 WHERE batch.status IN ('fetching', 'partial', 'synchronized');

-- The batch lifecycle trigger requires an explicit v2 writer declaration even
-- when the selected batch currently belongs to the legacy writer.
SELECT set_config('career_dashboard.ats_v2_writer', '2', true);

UPDATE "AtsAcquisitionWorkReceipt" receipt
   SET "finishedAt" = now(),
       "heartbeatAt" = now(),
       "leaseOwner" = NULL,
       "leaseToken" = NULL,
       "leaseExpiresAt" = NULL,
       "yieldReason" = 'permanent_retirement_alias_reconciliation_v1',
       error = 'permanent_retirement_alias_reconciliation_v1'
 WHERE receipt."batchId" IN (SELECT id FROM "_PermanentAtsRetirementBatches")
   AND receipt."finishedAt" IS NULL;

UPDATE "AtsEndpointSweepReceipt" sweep
   SET state = 'failed',
       outcome = 'operator_permanent_retirement_alias',
       "updatedAt" = now()
 WHERE sweep."batchId" IN (SELECT id FROM "_PermanentAtsRetirementBatches")
   AND sweep.state NOT IN ('failed', 'succeeded');

-- Status and lastError are the cross-writer lifecycle surface. Do not mutate
-- legacy lease/payload columns on a v2 batch; the database authority trigger
-- rejects that, and an excluded batch is not selectable even if a stale lease
-- receipt remains for audit history.
UPDATE "AtsIngestionBatch" batch
   SET status = 'excluded',
       "lastError" = 'permanent_retirement_alias_reconciliation_v1',
       "updatedAt" = now()
 WHERE batch.id IN (SELECT id FROM "_PermanentAtsRetirementBatches");

UPDATE "AtsCompany" board
   SET status = 'excluded',
       "excludedAt" = now(),
       "excludedReason" =
         'permanent_retirement_alias_reconciliation_v1: capitalization variant of permanently retired '
         || board.platform || '/' || alias."retiredSlug"
  FROM "_PermanentAtsRetirementAliases" alias
 WHERE board.slug = alias.slug
   AND board.platform = alias.platform
   AND board.status <> 'excluded';

COMMIT;
