BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

DO $$
DECLARE
  missing_objects TEXT[];
  missing_constraints TEXT[];
BEGIN
  SELECT array_agg(object_name ORDER BY object_name)
    INTO missing_objects
    FROM unnest(ARRAY[
      'AtsIngestionPage',
      'AtsListingObservation',
      'AtsListingObservationResolution',
      'AtsIngestionItem',
      'AtsAcquisitionWorkReceipt',
      'AtsEndpointSweepReceipt',
      'AtsEndpointDailyContactReceipt',
      'AtsIngestionSegment',
      'AtsAcquisitionRuntimeGate'
    ]) AS object_name
   WHERE to_regclass(format('"%s"', object_name)) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Missing ATS ledger tables: %', missing_objects;
  END IF;

  SELECT array_agg(required_name ORDER BY required_name)
    INTO missing_constraints
    FROM unnest(ARRAY[
      'AtsIngestionPage_batchId_generation_requestedOffset_key',
      'AtsListingObservation_pageId_pageOrdinal_key',
      'AtsListingObservationResolution_observationId_key',
      'AtsIngestionItem_batchId_ledgerGeneration_canonicalOrdinal_key',
      'AtsEndpointDailyContactReceipt_localDay_slug_platform_conta_key',
      'AtsIngestionSegment_bounds_check',
      'AtsIngestionSegment_no_overlap'
    ]) AS required_name
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_constraint constraint_row
      WHERE constraint_row.conname = required_name
   )
   AND NOT EXISTS (
     SELECT 1
       FROM pg_indexes index_row
      WHERE index_row.indexname = required_name
   );
  IF missing_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'Missing ATS ledger uniqueness/bounds authorities: %', missing_constraints;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'AtsBoardCheckAttempt_legacy_writer_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'AtsIngestionBatch_legacy_writer_guard' AND NOT tgisinternal
  ) OR to_regprocedure('claim_ats_batch_for_v2_conversion(text,text,text,timestamp without time zone)') IS NULL THEN
    RAISE EXCEPTION 'ATS legacy/v2 database writer fences are incomplete.';
  END IF;

  IF (SELECT COUNT(*) FROM "AtsAcquisitionRuntimeGate") <> 1
     OR NOT EXISTS (SELECT 1 FROM "AtsAcquisitionRuntimeGate" WHERE id = 'global') THEN
    RAISE EXCEPTION 'ATS acquisition runtime gate is not the required singleton.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."rawObservationCount" <> (
         SELECT COUNT(*) FROM "AtsListingObservation" observation
          WHERE observation."batchId" = batch.id
       )
  ) THEN
    RAISE EXCEPTION 'A v2 batch raw-observation header count does not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."canonicalOccurrenceCount" <> (
         SELECT COUNT(*) FROM "AtsIngestionItem" item
          WHERE item."batchId" = batch.id
            AND item."ledgerGeneration" = batch."activeLedgerGeneration"
       ) + batch."compactedOccurrenceCount"
  ) THEN
    RAISE EXCEPTION 'A v2 batch canonical/compacted occurrence count does not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."terminalItemCount" <> (
         SELECT COUNT(*) FROM "AtsIngestionItem" item
          WHERE item."batchId" = batch.id
            AND item."ledgerGeneration" = batch."activeLedgerGeneration"
            AND item."terminalAt" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'A v2 batch terminal-item count does not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."sealedItemCount" <> (
         SELECT COALESCE(SUM(segment."itemCount"), 0)
           FROM "AtsIngestionSegment" segment
          WHERE segment."batchId" = batch.id
            AND segment."ledgerGeneration" = batch."activeLedgerGeneration"
       )
  ) THEN
    RAISE EXCEPTION 'A v2 batch sealed-item count does not reconcile with its immutable segments.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."publishedItemCount" <> (
         SELECT COALESCE(SUM(segment."itemCount"), 0)
           FROM "AtsIngestionSegment" segment
          WHERE segment."batchId" = batch.id
            AND segment."ledgerGeneration" = batch."activeLedgerGeneration"
            AND segment."publishedAt" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'A v2 batch published-item count does not reconcile with its segment receipts.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionSegment" segment
     WHERE segment."processingOffset" <> (
       segment."insertedCount"
       + segment."duplicateCount"
       + segment."filteredCount"
       + segment."processingErrorCount"
     )
       OR (
         segment."processedAt" IS NOT NULL
         AND segment."processingOffset" <> segment."itemCount"
       )
  ) THEN
    RAISE EXCEPTION 'An ATS segment processing cursor or outcome count does not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch."sealedItemCount" > 0
       AND (batch."manifestHash" IS NULL OR btrim(batch."manifestHash") = '')
  ) OR EXISTS (
    SELECT 1 FROM "AtsIngestionPage" page
     WHERE btrim(page."responseHash") = ''
        OR btrim(page."identityMultisetHash") = ''
        OR (page."rawBody" IS NOT NULL AND (page."rawBodyHash" IS NULL OR btrim(page."rawBodyHash") = ''))
  ) OR EXISTS (
    SELECT 1 FROM "AtsListingObservation" observation
     WHERE btrim(observation."rawHash") = ''
  ) OR EXISTS (
    SELECT 1 FROM "AtsListingObservationResolution" resolution
     WHERE btrim(resolution."resolutionHash") = ''
  ) OR EXISTS (
    SELECT 1 FROM "AtsIngestionItem" item
     WHERE btrim(item."rawHash") = ''
  ) OR EXISTS (
    SELECT 1 FROM "AtsIngestionSegment" segment
     WHERE btrim(segment."manifestHash") = ''
  ) THEN
    RAISE EXCEPTION 'An ATS ledger integrity hash is missing or empty.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionPage" page
     WHERE page."materializationCompleteAt" IS NOT NULL
       AND page."responseItemCount" <> (
         SELECT COUNT(*) FROM "AtsListingObservation" observation
          WHERE observation."pageId" = page.id
       )
  ) THEN
    RAISE EXCEPTION 'A completed page materialization count does not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch.status IN ('queued', 'processing', 'processed')
       AND EXISTS (
         SELECT 1 FROM "AtsListingObservation" observation
          WHERE observation."batchId" = batch.id
            AND NOT EXISTS (
              SELECT 1 FROM "AtsListingObservationResolution" resolution
               WHERE resolution."observationId" = observation.id
            )
       )
  ) THEN
    RAISE EXCEPTION 'A synchronized/processed v2 batch contains unresolved raw observations.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AtsIngestionBatch" batch
     WHERE batch."archiveLocation" IS NOT NULL
       AND (
         batch."archiveContentHash" IS NULL
         OR batch."archiveBytes" IS NULL
         OR batch."archiveVerifiedAt" IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'An ATS archive location lacks content hash, byte count, or read-back verification.';
  END IF;
END;
$$;

SELECT
  COUNT(*) FILTER (WHERE "writerMode" = 'legacy')::bigint AS "legacyBatches",
  COUNT(*) FILTER (WHERE "writerMode" = 'converting')::bigint AS "convertingBatches",
  COUNT(*) FILTER (WHERE "writerMode" = 'v2')::bigint AS "v2Batches",
  COALESCE(SUM("rawObservationCount"), 0)::bigint AS "rawObservations",
  COALESCE(SUM("canonicalOccurrenceCount"), 0)::bigint AS "canonicalOccurrences",
  COALESCE(SUM("compactedOccurrenceCount"), 0)::bigint AS "compactedOccurrences",
  COALESCE(SUM("terminalItemCount"), 0)::bigint AS "terminalItems",
  COALESCE(SUM("sealedItemCount"), 0)::bigint AS "sealedItems",
  COALESCE(SUM("publishedItemCount"), 0)::bigint AS "publishedItems",
  COALESCE(SUM("acquisitionBytes"), 0)::bigint AS "acquisitionBytes"
FROM "AtsIngestionBatch";

WITH daily_growth AS (
  SELECT
    "partitionDay",
    COUNT(DISTINCT "batchId")::numeric AS cycles,
    COALESCE(SUM("rawBodyBytes"), 0)::numeric AS bytes
  FROM "AtsIngestionPage"
  GROUP BY "partitionDay"
), averages AS (
  SELECT
    COALESCE(SUM(bytes) / NULLIF(SUM(cycles), 0), 0) AS bytes_per_cycle,
    COALESCE(AVG(bytes), 0) AS bytes_per_day
  FROM daily_growth
)
SELECT
  ROUND(bytes_per_cycle)::bigint AS "measuredBytesPerCycle",
  ROUND(bytes_per_day * 7)::bigint AS "projectedHotBytes7Days",
  ROUND(bytes_per_day * 30)::bigint AS "projectedHotBytes30Days",
  ROUND(bytes_per_day * 90)::bigint AS "projectedHotBytes90Days"
FROM averages;

ROLLBACK;
