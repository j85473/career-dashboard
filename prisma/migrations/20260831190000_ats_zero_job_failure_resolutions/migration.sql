-- Preserve every terminal acquisition failure while allowing a clean cutover
-- to distinguish a proven-empty provider attempt from unprocessed job work.
CREATE TABLE "AtsZeroJobFailureResolution" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "resolutionKind" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsZeroJobFailureResolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AtsZeroJobFailureResolution_kind_check" CHECK (
    "resolutionKind" = 'verified_zero_job_transport_failure'
  ),
  CONSTRAINT "AtsZeroJobFailureResolution_hash_check" CHECK (
    "evidenceHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "AtsZeroJobFailureResolution_evidence_check" CHECK (
    "evidence" ?& ARRAY[
      'batchId', 'resolutionKind', 'writerMode', 'status',
      'jobCount', 'payloadItemCount'
    ]
    AND "evidence" ->> 'batchId' = "batchId"
    AND "evidence" ->> 'resolutionKind' = "resolutionKind"
    AND "evidence" ->> 'writerMode' = 'legacy'
    AND "evidence" ->> 'status' = 'failed'
    AND ("evidence" ->> 'jobCount')::integer = 0
    AND ("evidence" ->> 'payloadItemCount')::integer = 0
  )
);

CREATE UNIQUE INDEX "AtsZeroJobFailureResolution_batchId_key"
  ON "AtsZeroJobFailureResolution"("batchId");
CREATE UNIQUE INDEX "AtsZeroJobFailureResolution_evidenceHash_key"
  ON "AtsZeroJobFailureResolution"("evidenceHash");
CREATE INDEX "AtsZeroJobFailureResolution_resolutionKind_resolvedAt_idx"
  ON "AtsZeroJobFailureResolution"("resolutionKind", "resolvedAt");

ALTER TABLE "AtsZeroJobFailureResolution"
  ADD CONSTRAINT "AtsZeroJobFailureResolution_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_ats_zero_job_failure_resolution_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  source_batch "AtsIngestionBatch"%ROWTYPE;
BEGIN
  SELECT * INTO source_batch
    FROM "AtsIngestionBatch"
   WHERE id = NEW."batchId"
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'ATS zero-job failure resolution requires its source batch.';
  END IF;

  IF source_batch."writerMode" <> 'legacy'
    OR source_batch.status <> 'failed'
    OR source_batch."processedAt" IS NOT NULL
    OR source_batch."jobCount" <> 0
    OR source_batch.payload IS DISTINCT FROM '[]'::jsonb
    OR source_batch."processingOffset" <> 0
    OR source_batch."insertedCount" <> 0
    OR source_batch."duplicateCount" <> 0
    OR source_batch."filteredCount" <> 0
    OR source_batch."processingErrorCount" <> 0
    OR source_batch."leaseToken" IS NOT NULL
    OR source_batch."leaseOwner" IS NOT NULL
    OR source_batch."leaseStartedAt" IS NOT NULL
    OR source_batch."leaseExpiresAt" IS NOT NULL
    OR source_batch."acquisitionClaimToken" IS NOT NULL
    OR source_batch."acquisitionClaimOwner" IS NOT NULL
    OR source_batch."acquisitionLeaseExpiresAt" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "AtsIngestionPage" page WHERE page."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsListingObservation" observation WHERE observation."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsListingObservationResolution" resolution WHERE resolution."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsIngestionItem" item WHERE item."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsAcquisitionWorkReceipt" receipt WHERE receipt."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsEndpointSweepReceipt" sweep WHERE sweep."batchId" = source_batch.id)
    OR EXISTS (SELECT 1 FROM "AtsIngestionSegment" segment WHERE segment."batchId" = source_batch.id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ATS zero-job failure resolution rejected non-empty or claimed source work.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "validate_ats_zero_job_failure_resolution_insert"
BEFORE INSERT ON "AtsZeroJobFailureResolution"
FOR EACH ROW EXECUTE FUNCTION "enforce_ats_zero_job_failure_resolution_insert"();

CREATE FUNCTION "reject_ats_zero_job_failure_resolution_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ATS zero-job failure resolutions are immutable evidence.';
END;
$$;

CREATE TRIGGER "guard_ats_zero_job_failure_resolution_immutable"
BEFORE UPDATE OR DELETE ON "AtsZeroJobFailureResolution"
FOR EACH ROW EXECUTE FUNCTION "reject_ats_zero_job_failure_resolution_change"();
