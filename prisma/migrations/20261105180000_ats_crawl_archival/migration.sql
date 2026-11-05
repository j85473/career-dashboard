-- Verified cold storage preserves the complete evidence in two recoverable
-- copies. Only the dedicated PostgreSQL maintenance identity can retire rows.
-- Jobs, scores, source observations, histories, and outcome receipts are untouched.
CREATE FUNCTION "ats_verified_archive_delete_permitted"(batch_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT current_user='postgres'
   AND current_setting('career_dashboard.archive_batch',true)=batch_id
   AND EXISTS (SELECT 1 FROM "AtsIngestionBatch" b WHERE b.id=batch_id
     AND b."writerMode"='v2' AND b.status='processed' AND b."operatorResetAt" IS NULL
     AND b."processedAt" < (now() AT TIME ZONE 'UTC')-interval '30 days'
     AND b."archiveVerifiedAt" IS NOT NULL AND b."archiveBytes">0
     AND b."archiveContentHash" ~ '^[a-f0-9]{64}$'
     AND b."archiveLocation" ~ '^v1/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-f0-9-]{36}-[a-f0-9]{64}[.]json[.]gz$')
$$;

CREATE FUNCTION "guard_ats_archive_receipt"()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD."archiveVerifiedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Verified crawl archive receipts and completed summaries are immutable';
 END IF;
 IF OLD."archiveVerifiedAt" IS NULL AND NEW."archiveVerifiedAt" IS NOT NULL THEN
   IF current_user <> 'postgres' OR current_setting('career_dashboard.archive_batch',true) IS DISTINCT FROM NEW.id
      OR NEW.status <> 'processed' OR NEW."writerMode" <> 'v2' OR NEW."operatorResetAt" IS NOT NULL
      OR NEW."processedAt" IS NULL OR NEW."processedAt" >= (now() AT TIME ZONE 'UTC')-interval '30 days'
      OR NEW."archiveBytes" IS NULL OR NEW."archiveBytes" <= 0
      OR NEW."archiveContentHash" IS NULL OR NEW."archiveContentHash" !~ '^[a-f0-9]{64}$'
      OR NEW."archiveLocation" IS NULL OR NEW."archiveLocation" !~ '^v1/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-f0-9-]{36}-[a-f0-9]{64}[.]json[.]gz$' THEN
     RAISE EXCEPTION 'Crawl archival requires the maintenance identity and a verified completed-batch receipt';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "AtsIngestionBatch_archive_receipt_guard" BEFORE UPDATE ON "AtsIngestionBatch"
FOR EACH ROW EXECUTE FUNCTION "guard_ats_archive_receipt"();

CREATE OR REPLACE FUNCTION "guard_ats_ingestion_page_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('AtsIngestionPage','AtsListingObservation','AtsListingObservationResolution','AtsIngestionItem')
     AND "ats_verified_archive_delete_permitted"(OLD."batchId") THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion pages are append-only evidence.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW."requestedOffset" IS DISTINCT FROM OLD."requestedOffset"
     OR NEW."requestedLimit" IS DISTINCT FROM OLD."requestedLimit"
     OR NEW."providerOffset" IS DISTINCT FROM OLD."providerOffset"
     OR NEW."providerTotal" IS DISTINCT FROM OLD."providerTotal"
     OR NEW."responseItemCount" IS DISTINCT FROM OLD."responseItemCount"
     OR NEW."responseHash" IS DISTINCT FROM OLD."responseHash"
     OR NEW."identityMultisetHash" IS DISTINCT FROM OLD."identityMultisetHash"
     OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW."rawBody" IS DISTINCT FROM OLD."rawBody"
     OR NEW."rawBodyHash" IS DISTINCT FROM OLD."rawBodyHash"
     OR NEW."rawBodyBytes" IS DISTINCT FROM OLD."rawBodyBytes"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."respondedAt" IS DISTINCT FROM OLD."respondedAt"
     OR NEW."httpStatus" IS DISTINCT FROM OLD."httpStatus"
     OR NEW."partitionDay" IS DISTINCT FROM OLD."partitionDay"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion page evidence cannot be rewritten.';
  END IF;

  IF NEW."materializationOffset" < OLD."materializationOffset"
     OR NEW."materializationOffset" > NEW."responseItemCount" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS page materialization progress must be monotonic and bounded.';
  END IF;

  IF OLD."materializationCompleteAt" IS NOT NULL
     AND NEW."materializationCompleteAt" IS DISTINCT FROM OLD."materializationCompleteAt" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Completed ATS page materialization is immutable.';
  END IF;

  IF NEW."materializationCompleteAt" IS NOT NULL
     AND NEW."materializationOffset" <> NEW."responseItemCount" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS page materialization cannot complete before every occurrence is durable.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "reject_ats_append_only_evidence_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('AtsIngestionPage','AtsListingObservation','AtsListingObservationResolution','AtsIngestionItem')
     AND "ats_verified_archive_delete_permitted"(OLD."batchId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%s rows are append-only evidence.', TG_TABLE_NAME);
END;
$$;

CREATE OR REPLACE FUNCTION "guard_ats_ingestion_item_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('AtsIngestionPage','AtsListingObservation','AtsListingObservationResolution','AtsIngestionItem')
     AND "ats_verified_archive_delete_permitted"(OLD."batchId") THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion items cannot be deleted.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW."ledgerGeneration" IS DISTINCT FROM OLD."ledgerGeneration"
     OR NEW."canonicalOrdinal" IS DISTINCT FROM OLD."canonicalOrdinal"
     OR NEW."representativeObservationId" IS DISTINCT FROM OLD."representativeObservationId"
     OR NEW."providerSourceId" IS DISTINCT FROM OLD."providerSourceId"
     OR NEW."rawHash" IS DISTINCT FROM OLD."rawHash"
     OR NEW."rawJson" IS DISTINCT FROM OLD."rawJson"
     OR NEW."rawReference" IS DISTINCT FROM OLD."rawReference"
     OR NEW."partitionDay" IS DISTINCT FROM OLD."partitionDay"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion item identity and raw evidence cannot be rewritten.';
  END IF;

  IF OLD."enrichmentStatus" <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Terminal ATS ingestion items are immutable.';
  END IF;

  IF NEW."enrichmentStatus" NOT IN ('pending', 'terminal')
     OR (OLD."enrichmentStatus" = 'pending' AND NEW."enrichmentStatus" NOT IN ('pending', 'terminal')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS item enrichment has an invalid state transition.';
  END IF;

  IF NEW."itemClaimFence" < OLD."itemClaimFence"
     OR NEW."detailAttemptCount" < OLD."detailAttemptCount" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS item fences and attempt counts must be monotonic.';
  END IF;

  IF NEW."enrichmentStatus" = 'terminal' AND NEW."terminalAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Terminal ATS ingestion items require a terminal receipt time.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE INDEX "AtsIngestionBatch_pending_archive_idx" ON "AtsIngestionBatch"(id,"processedAt")
 WHERE "writerMode"='v2' AND status='processed' AND "archiveVerifiedAt" IS NULL AND "operatorResetAt" IS NULL AND "rawObservationCount">0;
CREATE INDEX "AtsIngestionBatch_archived_board_idx" ON "AtsIngestionBatch"(slug,platform)
 WHERE "archiveVerifiedAt" IS NOT NULL;
