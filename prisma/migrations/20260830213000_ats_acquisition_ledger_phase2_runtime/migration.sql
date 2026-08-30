-- Phase 2 keeps segment-publication hysteresis durable across worker and
-- service restarts. These columns are additive and remain dormant while the
-- v2 publication flag is disabled.
ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD COLUMN "publicationPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publicationPausedAt" TIMESTAMP(3),
  ADD COLUMN "publicationBacklogJobs" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AtsIngestionPage"
  ADD COLUMN "metadata" JSONB;

ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_publication_backlog_check"
  CHECK ("publicationBacklogJobs" >= 0);

-- Phase 1 intentionally rejected every legacy-shaped write once a batch moved
-- to converting/v2. Phase 2 adds an explicit transaction-local capability for
-- the compatible v2 binary to update only lifecycle summary fields. Even an
-- authorized v2 transaction can never mutate the legacy JSON payload, cursor,
-- counters, or batch-level consumer lease.
CREATE OR REPLACE FUNCTION "guard_legacy_ats_batch_write"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  board_engine TEXT;
  guarded_change BOOLEAN;
  legacy_authority_change BOOLEAN;
  v2_lifecycle_change BOOLEAN;
  v2_writer_authorized BOOLEAN;
BEGIN
  SELECT "acquisitionEngine"
    INTO board_engine
    FROM "AtsCompany"
   WHERE slug = NEW.slug AND platform = NEW.platform
   FOR KEY SHARE;

  IF TG_OP = 'INSERT' THEN
    IF NEW."writerMode" = 'legacy' AND board_engine IS DISTINCT FROM 'legacy' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format(
          'Legacy ATS batch rejected for %s/%s: acquisition engine is %s.',
          NEW.platform, NEW.slug, COALESCE(board_engine, 'missing')
        );
    END IF;
    RETURN NEW;
  END IF;

  legacy_authority_change :=
    NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.cursor IS DISTINCT FROM OLD.cursor
    OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
    OR NEW."requestCount" IS DISTINCT FROM OLD."requestCount"
    OR NEW."pageCount" IS DISTINCT FROM OLD."pageCount"
    OR NEW."jobCount" IS DISTINCT FROM OLD."jobCount"
    OR NEW."insertedCount" IS DISTINCT FROM OLD."insertedCount"
    OR NEW."duplicateCount" IS DISTINCT FROM OLD."duplicateCount"
    OR NEW."filteredCount" IS DISTINCT FROM OLD."filteredCount"
    OR NEW."processingErrorCount" IS DISTINCT FROM OLD."processingErrorCount"
    OR NEW."processingAttemptCount" IS DISTINCT FROM OLD."processingAttemptCount"
    OR NEW."processingOffset" IS DISTINCT FROM OLD."processingOffset"
    OR NEW."nextProcessAt" IS DISTINCT FROM OLD."nextProcessAt"
    OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
    OR NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner"
    OR NEW."leaseStartedAt" IS DISTINCT FROM OLD."leaseStartedAt"
    OR NEW."heartbeatAt" IS DISTINCT FROM OLD."heartbeatAt"
    OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt";

  v2_lifecycle_change :=
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW."respondedAt" IS DISTINCT FROM OLD."respondedAt"
    OR NEW."synchronizedAt" IS DISTINCT FROM OLD."synchronizedAt"
    OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
    OR NEW."lastError" IS DISTINCT FROM OLD."lastError"
    OR NEW."writerMode" IS DISTINCT FROM OLD."writerMode";

  guarded_change := legacy_authority_change OR v2_lifecycle_change;
  v2_writer_authorized := COALESCE(
    current_setting('career_dashboard.ats_v2_writer', true) = '2',
    false
  );

  IF OLD."writerMode" IN ('converting', 'v2') AND legacy_authority_change THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'Legacy ATS authority write rejected for batch %s in %s mode.',
        OLD.id, OLD."writerMode"
      );
  END IF;

  IF OLD."writerMode" IN ('converting', 'v2')
     AND v2_lifecycle_change
     AND NOT v2_writer_authorized THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'ATS v2 lifecycle write rejected for batch %s without a compatible writer capability.',
        OLD.id
      );
  END IF;

  IF NEW."writerMode" = 'legacy'
     AND board_engine IS DISTINCT FROM 'legacy'
     AND guarded_change THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'Legacy ATS batch write rejected for batch %s: acquisition engine is %s.',
        OLD.id, COALESCE(board_engine, 'missing')
      );
  END IF;

  IF OLD."writerMode" IN ('converting', 'v2') AND NEW."writerMode" = 'legacy' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'ATS batch %s cannot fall back from %s to the legacy JSON writer.',
        OLD.id, OLD."writerMode"
      );
  END IF;

  IF NEW."ledgerVersion" < OLD."ledgerVersion"
     OR NEW."activeLedgerGeneration" < OLD."activeLedgerGeneration" THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('ATS ledger authority cannot move backwards for batch %s.', OLD.id);
  END IF;
  RETURN NEW;
END;
$$;

-- Ledger evidence is append-only. Page materialization progress is the only
-- mutable page state; the provider response, hashes, and metadata can never be
-- rewritten after the durable page receipt exists.
CREATE FUNCTION "guard_ats_ingestion_page_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
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

CREATE TRIGGER "guard_ats_ingestion_page_evidence"
BEFORE UPDATE OR DELETE ON "AtsIngestionPage"
FOR EACH ROW EXECUTE FUNCTION "guard_ats_ingestion_page_evidence"();

CREATE FUNCTION "reject_ats_append_only_evidence_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%s rows are append-only evidence.', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER "guard_ats_listing_observation_evidence"
BEFORE UPDATE OR DELETE ON "AtsListingObservation"
FOR EACH ROW EXECUTE FUNCTION "reject_ats_append_only_evidence_change"();

CREATE TRIGGER "guard_ats_listing_resolution_evidence"
BEFORE UPDATE OR DELETE ON "AtsListingObservationResolution"
FOR EACH ROW EXECUTE FUNCTION "reject_ats_append_only_evidence_change"();

-- Canonical item identity and raw evidence are immutable. Enrichment is a
-- fenced pending-to-terminal overlay; after terminalization the entire row is
-- frozen so a published segment's manifest cannot drift.
CREATE FUNCTION "guard_ats_ingestion_item_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
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

CREATE TRIGGER "guard_ats_ingestion_item_evidence"
BEFORE UPDATE OR DELETE ON "AtsIngestionItem"
FOR EACH ROW EXECUTE FUNCTION "guard_ats_ingestion_item_evidence"();

-- Segment bounds and manifest content are immutable. Only fenced publication,
-- lease, cursor, and aggregate processing state may advance.
CREATE FUNCTION "guard_ats_ingestion_segment_manifest"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion segments cannot be deleted.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW."ledgerGeneration" IS DISTINCT FROM OLD."ledgerGeneration"
     OR NEW."segmentOrdinal" IS DISTINCT FROM OLD."segmentOrdinal"
     OR NEW."segmentSize" IS DISTINCT FROM OLD."segmentSize"
     OR NEW."firstOrdinal" IS DISTINCT FROM OLD."firstOrdinal"
     OR NEW."lastOrdinal" IS DISTINCT FROM OLD."lastOrdinal"
     OR NEW."itemCount" IS DISTINCT FROM OLD."itemCount"
     OR NEW."manifestHash" IS DISTINCT FROM OLD."manifestHash"
     OR NEW."enrichmentVersion" IS DISTINCT FROM OLD."enrichmentVersion"
     OR NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt"
     OR NEW."partitionDay" IS DISTINCT FROM OLD."partitionDay"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion segment manifests cannot be rewritten.';
  END IF;

  IF OLD.status = 'sealed' AND NEW.status NOT IN ('sealed', 'published')
     OR OLD.status = 'published' AND NEW.status NOT IN ('published', 'processing')
     OR OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'published', 'processed')
     OR OLD.status = 'processed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS ingestion segment has an invalid state transition.';
  END IF;

  IF NEW."processingOffset" < OLD."processingOffset"
     OR NEW."processingOffset" > NEW."itemCount"
     OR NEW."insertedCount" < OLD."insertedCount"
     OR NEW."duplicateCount" < OLD."duplicateCount"
     OR NEW."filteredCount" < OLD."filteredCount"
     OR NEW."processingErrorCount" < OLD."processingErrorCount"
     OR NEW."leaseFence" < OLD."leaseFence" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS segment progress and fences must be monotonic and bounded.';
  END IF;

  IF NEW."processingOffset" <> NEW."insertedCount" + NEW."duplicateCount" + NEW."filteredCount" + NEW."processingErrorCount" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS segment cursor must reconcile exactly to its counters.';
  END IF;

  IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
     OR OLD."processedAt" IS NOT NULL AND NEW."processedAt" IS DISTINCT FROM OLD."processedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS segment publication and completion receipts are immutable.';
  END IF;

  IF NEW.status IN ('published', 'processing', 'processed') AND NEW."publishedAt" IS NULL
     OR NEW.status = 'processed' AND (NEW."processedAt" IS NULL OR NEW."processingOffset" <> NEW."itemCount") THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ATS segment state is missing its durable receipt or complete cursor.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_ats_ingestion_segment_manifest"
BEFORE UPDATE OR DELETE ON "AtsIngestionSegment"
FOR EACH ROW EXECUTE FUNCTION "guard_ats_ingestion_segment_manifest"();
