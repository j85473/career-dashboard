-- Phase 1 is expand-only. Legacy payload, metadata, cursor, attempts, and
-- compaction receipts remain authoritative until an explicit fenced conversion.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "AtsCompany"
  ADD COLUMN "acquisitionEngine" TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE "AtsBoardCheckAttempt"
  ADD COLUMN "workKind" TEXT NOT NULL DEFAULT 'legacy_claim',
  ADD COLUMN "transactionPhase" TEXT,
  ADD COLUMN "failureScope" TEXT;

ALTER TABLE "AtsIngestionBatch"
  ADD COLUMN "ledgerVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "writerMode" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "acquisitionPhase" TEXT NOT NULL DEFAULT 'listing',
  ADD COLUMN "nextAcquireAt" TIMESTAMP(3),
  ADD COLUMN "lastServedAt" TIMESTAMP(3),
  ADD COLUMN "listingGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "listingOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "latestObservedTotal" INTEGER,
  ADD COLUMN "listingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "rawObservationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "canonicalOccurrenceCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "compactedOccurrenceCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "terminalItemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sealedItemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedItemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "acquisitionBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "manifestHash" TEXT,
  ADD COLUMN "activeLedgerGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "conversionGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "segmentSize" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "acquisitionClaimToken" TEXT,
  ADD COLUMN "acquisitionClaimOwner" TEXT,
  ADD COLUMN "acquisitionClaimFence" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "acquisitionHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "acquisitionLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "archiveEligibleAt" TIMESTAMP(3),
  ADD COLUMN "archivePartitionDay" DATE,
  ADD COLUMN "archiveLocation" TEXT,
  ADD COLUMN "archiveContentHash" TEXT,
  ADD COLUMN "archiveBytes" BIGINT,
  ADD COLUMN "archiveVerifiedAt" TIMESTAMP(3);

CREATE TABLE "AtsIngestionPage" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "requestedOffset" INTEGER NOT NULL,
  "requestedLimit" INTEGER NOT NULL,
  "providerOffset" INTEGER,
  "providerTotal" INTEGER,
  "responseItemCount" INTEGER NOT NULL,
  "responseHash" TEXT NOT NULL,
  "identityMultisetHash" TEXT NOT NULL,
  "rawBody" JSONB,
  "rawBodyHash" TEXT,
  "rawBodyBytes" BIGINT NOT NULL DEFAULT 0,
  "materializationOffset" INTEGER NOT NULL DEFAULT 0,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "respondedAt" TIMESTAMP(3) NOT NULL,
  "httpStatus" INTEGER NOT NULL,
  "materializationCompleteAt" TIMESTAMP(3),
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsIngestionPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsListingObservation" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "pageOrdinal" INTEGER NOT NULL,
  "providerSourceId" TEXT,
  "rawHash" TEXT NOT NULL,
  "rawJson" JSONB,
  "rawSliceOffset" INTEGER,
  "rawSliceLength" INTEGER,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsListingObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsIngestionItem" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "ledgerGeneration" INTEGER NOT NULL DEFAULT 0,
  "canonicalOrdinal" INTEGER NOT NULL,
  "representativeObservationId" TEXT,
  "providerSourceId" TEXT,
  "rawHash" TEXT NOT NULL,
  "rawJson" JSONB,
  "rawReference" JSONB,
  "enrichmentOverlay" JSONB,
  "enrichmentVersion" INTEGER,
  "enrichmentStatus" TEXT NOT NULL DEFAULT 'pending',
  "enrichmentReason" TEXT,
  "detailHttpStatus" INTEGER,
  "detailError" TEXT,
  "detailAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextDetailAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "itemClaimToken" TEXT,
  "itemClaimOwner" TEXT,
  "itemClaimFence" BIGINT NOT NULL DEFAULT 0,
  "itemHeartbeatAt" TIMESTAMP(3),
  "itemLeaseExpiresAt" TIMESTAMP(3),
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsIngestionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsListingObservationResolution" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "itemId" TEXT,
  "ledgerGeneration" INTEGER NOT NULL DEFAULT 0,
  "resolutionType" TEXT NOT NULL,
  "occurrenceKey" TEXT,
  "resolutionHash" TEXT NOT NULL,
  "detail" JSONB,
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsListingObservationResolution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsEndpointSweepReceipt" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "admissionLocalDay" DATE NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'admitted',
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchIntentAt" TIMESTAMP(3),
  "contactConfirmedAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "synchronizedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "outcome" TEXT,
  "safetyBlockReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsEndpointSweepReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsAcquisitionWorkReceipt" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "legacyAttemptId" TEXT,
  "endpointSweepId" TEXT,
  "workType" TEXT NOT NULL,
  "startGeneration" INTEGER,
  "endGeneration" INTEGER,
  "startListingOffset" INTEGER,
  "endListingOffset" INTEGER,
  "startItemOrdinal" INTEGER,
  "endItemOrdinal" INTEGER,
  "listingRequestCount" INTEGER NOT NULL DEFAULT 0,
  "detailRequestCount" INTEGER NOT NULL DEFAULT 0,
  "itemsInspected" INTEGER NOT NULL DEFAULT 0,
  "itemsTerminalized" INTEGER NOT NULL DEFAULT 0,
  "itemsProgressed" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseFence" BIGINT NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "yieldReason" TEXT,
  "checkpointHash" TEXT,
  "transactionPhase" TEXT,
  "failureScope" TEXT,
  "ambiguousDispatch" BOOLEAN NOT NULL DEFAULT false,
  "adoptedCheckpoint" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT,
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsAcquisitionWorkReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsEndpointDailyContactReceipt" (
  "id" TEXT NOT NULL,
  "localDay" DATE NOT NULL,
  "slug" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "contactKind" TEXT NOT NULL,
  "contactConfirmedAt" TIMESTAMP(3) NOT NULL,
  "sweepId" TEXT,
  "workReceiptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsEndpointDailyContactReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsIngestionSegment" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "ledgerGeneration" INTEGER NOT NULL DEFAULT 0,
  "segmentOrdinal" INTEGER NOT NULL,
  "segmentSize" INTEGER NOT NULL,
  "firstOrdinal" INTEGER NOT NULL,
  "lastOrdinal" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "enrichmentVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sealed',
  "processingOffset" INTEGER NOT NULL DEFAULT 0,
  "insertedCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "filteredCount" INTEGER NOT NULL DEFAULT 0,
  "processingErrorCount" INTEGER NOT NULL DEFAULT 0,
  "nextProcessAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseOwner" TEXT,
  "leaseFence" BIGINT NOT NULL DEFAULT 0,
  "heartbeatAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "partitionDay" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsIngestionSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsAcquisitionRuntimeGate" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "minimumWriterVersion" INTEGER NOT NULL DEFAULT 1,
  "compatibilityWriterVersion" INTEGER NOT NULL DEFAULT 2,
  "compatibilityActivatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "v2AuthorityActivatedAt" TIMESTAMP(3),
  "activatedLedgerVersion" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsAcquisitionRuntimeGate_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AtsAcquisitionRuntimeGate" (
  "id", "minimumWriterVersion", "compatibilityWriterVersion", "updatedAt"
) VALUES ('global', 1, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "AtsCompany"
  ADD CONSTRAINT "AtsCompany_acquisitionEngine_check"
  CHECK ("acquisitionEngine" IN ('legacy', 'converting', 'v2'));

ALTER TABLE "AtsIngestionBatch"
  ADD CONSTRAINT "AtsIngestionBatch_writerMode_check"
    CHECK ("writerMode" IN ('legacy', 'converting', 'v2')),
  ADD CONSTRAINT "AtsIngestionBatch_ledger_counts_check"
    CHECK (
      "ledgerVersion" >= 1
      AND "listingGeneration" >= 0
      AND "listingOffset" >= 0
      AND ("latestObservedTotal" IS NULL OR "latestObservedTotal" >= 0)
      AND "rawObservationCount" >= 0
      AND "canonicalOccurrenceCount" >= 0
      AND "compactedOccurrenceCount" >= 0
      AND "terminalItemCount" >= 0
      AND "sealedItemCount" >= 0
      AND "publishedItemCount" >= 0
      AND "acquisitionBytes" >= 0
      AND "activeLedgerGeneration" >= 0
      AND "conversionGeneration" >= 0
      AND "segmentSize" >= 1
      AND "segmentSize" < 2000
      AND "acquisitionClaimFence" >= 0
      AND ("archiveBytes" IS NULL OR "archiveBytes" >= 0)
    );

ALTER TABLE "AtsIngestionPage"
  ADD CONSTRAINT "AtsIngestionPage_counts_check"
  CHECK (
    "generation" >= 0
    AND "requestedOffset" >= 0
    AND "requestedLimit" >= 1
    AND ("providerOffset" IS NULL OR "providerOffset" >= 0)
    AND ("providerTotal" IS NULL OR "providerTotal" >= 0)
    AND "responseItemCount" >= 0
    AND "rawBodyBytes" >= 0
    AND "materializationOffset" >= 0
    AND "materializationOffset" <= "responseItemCount"
  );

ALTER TABLE "AtsListingObservation"
  ADD CONSTRAINT "AtsListingObservation_ordinal_check"
  CHECK (
    "generation" >= 0
    AND "pageOrdinal" >= 0
    AND ("rawSliceOffset" IS NULL OR "rawSliceOffset" >= 0)
    AND ("rawSliceLength" IS NULL OR "rawSliceLength" >= 0)
  );

ALTER TABLE "AtsIngestionItem"
  ADD CONSTRAINT "AtsIngestionItem_counts_check"
  CHECK (
    "ledgerGeneration" >= 0
    AND "canonicalOrdinal" >= 0
    AND "detailAttemptCount" >= 0
    AND "itemClaimFence" >= 0
  );

ALTER TABLE "AtsAcquisitionWorkReceipt"
  ADD CONSTRAINT "AtsAcquisitionWorkReceipt_counts_check"
  CHECK (
    "listingRequestCount" >= 0
    AND "detailRequestCount" >= 0
    AND "itemsInspected" >= 0
    AND "itemsTerminalized" >= 0
    AND "itemsProgressed" >= 0
    AND "leaseFence" >= 0
  );

ALTER TABLE "AtsEndpointSweepReceipt"
  ADD CONSTRAINT "AtsEndpointSweepReceipt_state_check"
  CHECK ("state" IN ('admitted', 'dispatching', 'contact_confirmed', 'ambiguous', 'responded', 'failed'));

ALTER TABLE "AtsIngestionSegment"
  ADD CONSTRAINT "AtsIngestionSegment_bounds_check"
  CHECK (
    "ledgerGeneration" >= 0
    AND "segmentOrdinal" >= 0
    AND "segmentSize" >= 1
    AND "segmentSize" < 2000
    AND "firstOrdinal" = "segmentOrdinal" * "segmentSize"
    AND "itemCount" >= 1
    AND "itemCount" <= "segmentSize"
    AND "lastOrdinal" = "firstOrdinal" + "itemCount" - 1
    AND "processingOffset" >= 0
    AND "processingOffset" <= "itemCount"
    AND "insertedCount" >= 0
    AND "duplicateCount" >= 0
    AND "filteredCount" >= 0
    AND "processingErrorCount" >= 0
    AND "leaseFence" >= 0
  ),
  ADD CONSTRAINT "AtsIngestionSegment_no_overlap"
  EXCLUDE USING gist (
    "batchId" WITH =,
    "ledgerGeneration" WITH =,
    int4range("firstOrdinal", "lastOrdinal", '[]') WITH &&
  );

ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_singleton_check"
  CHECK ("id" = 'global'),
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_versions_check"
  CHECK (
    "minimumWriterVersion" >= 1
    AND "compatibilityWriterVersion" >= "minimumWriterVersion"
    AND ("activatedLedgerVersion" IS NULL OR "activatedLedgerVersion" >= 2)
  );

CREATE UNIQUE INDEX "AtsIngestionBatch_acquisitionClaimToken_key"
  ON "AtsIngestionBatch"("acquisitionClaimToken");
CREATE INDEX "AtsCompany_acquisitionEngine_status_nextCheckDate_idx"
  ON "AtsCompany"("acquisitionEngine", "status", "nextCheckDate");
CREATE INDEX "AtsBoardCheckAttempt_workKind_startedAt_idx"
  ON "AtsBoardCheckAttempt"("workKind", "startedAt");
CREATE INDEX "AtsBoardCheckAttempt_transactionPhase_startedAt_idx"
  ON "AtsBoardCheckAttempt"("transactionPhase", "startedAt");
CREATE INDEX "AtsBoardCheckAttempt_failureScope_startedAt_idx"
  ON "AtsBoardCheckAttempt"("failureScope", "startedAt");
CREATE INDEX "AtsIngestionBatch_writerMode_acquisitionPhase_nextAcquireAt_idx"
  ON "AtsIngestionBatch"("writerMode", "acquisitionPhase", "nextAcquireAt", "lastServedAt");
CREATE INDEX "AtsIngestionBatch_acquisitionLeaseExpiresAt_idx"
  ON "AtsIngestionBatch"("acquisitionLeaseExpiresAt");
CREATE INDEX "AtsIngestionBatch_archivePartitionDay_archiveEligibleAt_idx"
  ON "AtsIngestionBatch"("archivePartitionDay", "archiveEligibleAt");

CREATE UNIQUE INDEX "AtsIngestionPage_batchId_generation_requestedOffset_key"
  ON "AtsIngestionPage"("batchId", "generation", "requestedOffset");
CREATE INDEX "AtsIngestionPage_batchId_generation_requestedOffset_idx"
  ON "AtsIngestionPage"("batchId", "generation", "requestedOffset");
CREATE INDEX "AtsIngestionPage_partitionDay_createdAt_idx"
  ON "AtsIngestionPage"("partitionDay", "createdAt");

CREATE UNIQUE INDEX "AtsListingObservation_pageId_pageOrdinal_key"
  ON "AtsListingObservation"("pageId", "pageOrdinal");
CREATE INDEX "AtsListingObservation_batchId_generation_providerSourceId_idx"
  ON "AtsListingObservation"("batchId", "generation", "providerSourceId");
CREATE INDEX "AtsListingObservation_batchId_generation_rawHash_idx"
  ON "AtsListingObservation"("batchId", "generation", "rawHash");
CREATE INDEX "AtsListingObservation_partitionDay_observedAt_idx"
  ON "AtsListingObservation"("partitionDay", "observedAt");

CREATE UNIQUE INDEX "AtsIngestionItem_itemClaimToken_key"
  ON "AtsIngestionItem"("itemClaimToken");
CREATE UNIQUE INDEX "AtsIngestionItem_batchId_ledgerGeneration_canonicalOrdinal_key"
  ON "AtsIngestionItem"("batchId", "ledgerGeneration", "canonicalOrdinal");
CREATE INDEX "AtsIngestionItem_batchId_ledgerGeneration_enrichmentStatus__idx"
  ON "AtsIngestionItem"("batchId", "ledgerGeneration", "enrichmentStatus", "nextDetailAt", "canonicalOrdinal");
CREATE INDEX "AtsIngestionItem_batchId_ledgerGeneration_providerSourceId_idx"
  ON "AtsIngestionItem"("batchId", "ledgerGeneration", "providerSourceId");
CREATE INDEX "AtsIngestionItem_itemLeaseExpiresAt_idx"
  ON "AtsIngestionItem"("itemLeaseExpiresAt");
CREATE INDEX "AtsIngestionItem_partitionDay_createdAt_idx"
  ON "AtsIngestionItem"("partitionDay", "createdAt");

CREATE UNIQUE INDEX "AtsListingObservationResolution_observationId_key"
  ON "AtsListingObservationResolution"("observationId");
CREATE INDEX "AtsListingObservationResolution_batchId_ledgerGeneration_re_idx"
  ON "AtsListingObservationResolution"("batchId", "ledgerGeneration", "resolutionType");
CREATE INDEX "AtsListingObservationResolution_itemId_idx"
  ON "AtsListingObservationResolution"("itemId");
CREATE INDEX "AtsListingObservationResolution_partitionDay_createdAt_idx"
  ON "AtsListingObservationResolution"("partitionDay", "createdAt");

CREATE UNIQUE INDEX "AtsEndpointSweepReceipt_batchId_key"
  ON "AtsEndpointSweepReceipt"("batchId");
CREATE INDEX "AtsEndpointSweepReceipt_admissionLocalDay_state_idx"
  ON "AtsEndpointSweepReceipt"("admissionLocalDay", "state");
CREATE INDEX "AtsEndpointSweepReceipt_slug_platform_admittedAt_idx"
  ON "AtsEndpointSweepReceipt"("slug", "platform", "admittedAt");

CREATE UNIQUE INDEX "AtsAcquisitionWorkReceipt_leaseToken_key"
  ON "AtsAcquisitionWorkReceipt"("leaseToken");
CREATE INDEX "AtsAcquisitionWorkReceipt_workType_startedAt_idx"
  ON "AtsAcquisitionWorkReceipt"("workType", "startedAt");
CREATE INDEX "AtsAcquisitionWorkReceipt_batchId_startedAt_idx"
  ON "AtsAcquisitionWorkReceipt"("batchId", "startedAt");
CREATE INDEX "AtsAcquisitionWorkReceipt_leaseExpiresAt_idx"
  ON "AtsAcquisitionWorkReceipt"("leaseExpiresAt");
CREATE INDEX "AtsAcquisitionWorkReceipt_transactionPhase_startedAt_idx"
  ON "AtsAcquisitionWorkReceipt"("transactionPhase", "startedAt");
CREATE INDEX "AtsAcquisitionWorkReceipt_partitionDay_createdAt_idx"
  ON "AtsAcquisitionWorkReceipt"("partitionDay", "createdAt");

CREATE UNIQUE INDEX "AtsEndpointDailyContactReceipt_localDay_slug_platform_conta_key"
  ON "AtsEndpointDailyContactReceipt"("localDay", "slug", "platform", "contactKind");
CREATE INDEX "AtsEndpointDailyContactReceipt_contactKind_contactConfirmed_idx"
  ON "AtsEndpointDailyContactReceipt"("contactKind", "contactConfirmedAt");
CREATE INDEX "AtsEndpointDailyContactReceipt_sweepId_idx"
  ON "AtsEndpointDailyContactReceipt"("sweepId");

CREATE UNIQUE INDEX "AtsIngestionSegment_leaseToken_key"
  ON "AtsIngestionSegment"("leaseToken");
CREATE UNIQUE INDEX "AtsIngestionSegment_batchId_ledgerGeneration_segmentOrdinal_key"
  ON "AtsIngestionSegment"("batchId", "ledgerGeneration", "segmentOrdinal");
CREATE UNIQUE INDEX "AtsIngestionSegment_batchId_ledgerGeneration_firstOrdinal_l_key"
  ON "AtsIngestionSegment"("batchId", "ledgerGeneration", "firstOrdinal", "lastOrdinal");
CREATE INDEX "AtsIngestionSegment_status_nextProcessAt_createdAt_idx"
  ON "AtsIngestionSegment"("status", "nextProcessAt", "createdAt");
CREATE INDEX "AtsIngestionSegment_batchId_ledgerGeneration_firstOrdinal_idx"
  ON "AtsIngestionSegment"("batchId", "ledgerGeneration", "firstOrdinal");
CREATE INDEX "AtsIngestionSegment_leaseExpiresAt_idx"
  ON "AtsIngestionSegment"("leaseExpiresAt");
CREATE INDEX "AtsIngestionSegment_partitionDay_createdAt_idx"
  ON "AtsIngestionSegment"("partitionDay", "createdAt");

ALTER TABLE "AtsIngestionPage"
  ADD CONSTRAINT "AtsIngestionPage_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AtsListingObservation"
  ADD CONSTRAINT "AtsListingObservation_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsListingObservation_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "AtsIngestionPage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AtsIngestionItem"
  ADD CONSTRAINT "AtsIngestionItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsIngestionItem_representativeObservationId_fkey"
  FOREIGN KEY ("representativeObservationId") REFERENCES "AtsListingObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AtsListingObservationResolution"
  ADD CONSTRAINT "AtsListingObservationResolution_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsListingObservationResolution_observationId_fkey"
  FOREIGN KEY ("observationId") REFERENCES "AtsListingObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsListingObservationResolution_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "AtsIngestionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AtsEndpointSweepReceipt"
  ADD CONSTRAINT "AtsEndpointSweepReceipt_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsEndpointSweepReceipt_slug_platform_fkey"
  FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AtsAcquisitionWorkReceipt"
  ADD CONSTRAINT "AtsAcquisitionWorkReceipt_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsAcquisitionWorkReceipt_legacyAttemptId_fkey"
  FOREIGN KEY ("legacyAttemptId") REFERENCES "AtsBoardCheckAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsAcquisitionWorkReceipt_endpointSweepId_fkey"
  FOREIGN KEY ("endpointSweepId") REFERENCES "AtsEndpointSweepReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AtsEndpointDailyContactReceipt"
  ADD CONSTRAINT "AtsEndpointDailyContactReceipt_slug_platform_fkey"
  FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsEndpointDailyContactReceipt_sweepId_fkey"
  FOREIGN KEY ("sweepId") REFERENCES "AtsEndpointSweepReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AtsEndpointDailyContactReceipt_workReceiptId_fkey"
  FOREIGN KEY ("workReceiptId") REFERENCES "AtsAcquisitionWorkReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AtsIngestionSegment"
  ADD CONSTRAINT "AtsIngestionSegment_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced compatibility fence. Attempt creation takes key-share
-- locks on the board and batch; conversion takes update locks in the opposite
-- authority transition. Whichever wins makes the losing path fail closed.
CREATE OR REPLACE FUNCTION "guard_legacy_ats_attempt_write"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  board_engine TEXT;
  batch_mode TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT "acquisitionEngine"
    INTO board_engine
    FROM "AtsCompany"
   WHERE slug = NEW.slug AND platform = NEW.platform
   FOR KEY SHARE;

  IF board_engine IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'Legacy ATS attempt rejected for %s/%s: acquisition engine is %s.',
        NEW.platform, NEW.slug, COALESCE(board_engine, 'missing')
      );
  END IF;

  IF NEW."batchId" IS NOT NULL THEN
    SELECT "writerMode"
      INTO batch_mode
      FROM "AtsIngestionBatch"
     WHERE id = NEW."batchId"
     FOR KEY SHARE;
    IF batch_mode IS DISTINCT FROM 'legacy' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format(
          'Legacy ATS attempt rejected for batch %s: writer mode is %s.',
          NEW."batchId", COALESCE(batch_mode, 'missing')
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AtsBoardCheckAttempt_legacy_writer_guard"
BEFORE INSERT ON "AtsBoardCheckAttempt"
FOR EACH ROW EXECUTE FUNCTION "guard_legacy_ats_attempt_write"();

CREATE OR REPLACE FUNCTION "guard_legacy_ats_batch_write"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  board_engine TEXT;
  guarded_change BOOLEAN;
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

  guarded_change :=
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.payload IS DISTINCT FROM OLD.payload
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
    OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
    OR NEW."respondedAt" IS DISTINCT FROM OLD."respondedAt"
    OR NEW."synchronizedAt" IS DISTINCT FROM OLD."synchronizedAt"
    OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
    OR NEW."lastError" IS DISTINCT FROM OLD."lastError";

  IF OLD."writerMode" IN ('converting', 'v2') AND guarded_change THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'Legacy ATS batch write rejected for batch %s in %s mode.',
        OLD.id, OLD."writerMode"
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

CREATE TRIGGER "AtsIngestionBatch_legacy_writer_guard"
BEFORE INSERT OR UPDATE ON "AtsIngestionBatch"
FOR EACH ROW EXECUTE FUNCTION "guard_legacy_ats_batch_write"();

-- Dormant Phase 1 conversion claim. It changes only authority/fence fields and
-- cannot claim a batch with a running legacy attempt or consumer lease.
CREATE OR REPLACE FUNCTION "claim_ats_batch_for_v2_conversion"(
  p_batch_id TEXT,
  p_claim_token TEXT,
  p_claim_owner TEXT,
  p_lease_expires_at TIMESTAMP(3)
)
RETURNS TABLE (
  "batchId" TEXT,
  "conversionGeneration" INTEGER,
  "claimFence" BIGINT
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  locked_batch "AtsIngestionBatch"%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR btrim(p_claim_token) = ''
     OR p_claim_owner IS NULL OR btrim(p_claim_owner) = ''
     OR p_lease_expires_at <= clock_timestamp() AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid ATS v2 conversion claim.';
  END IF;

  SELECT * INTO locked_batch
    FROM "AtsIngestionBatch"
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1 FROM "AtsCompany"
   WHERE slug = locked_batch.slug AND platform = locked_batch.platform
   FOR UPDATE;

  IF locked_batch."writerMode" <> 'legacy'
     OR locked_batch."leaseToken" IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM "AtsBoardCheckAttempt" attempt
        WHERE attempt."batchId" = locked_batch.id
          AND attempt.outcome = 'running'
     ) THEN
    RETURN;
  END IF;

  UPDATE "AtsCompany"
     SET "acquisitionEngine" = 'converting'
   WHERE slug = locked_batch.slug
     AND platform = locked_batch.platform
     AND "acquisitionEngine" = 'legacy';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE "AtsIngestionBatch" AS target
     SET "writerMode" = 'converting',
         "acquisitionPhase" = 'conversion',
         "conversionGeneration" = target."conversionGeneration" + 1,
         "acquisitionClaimToken" = p_claim_token,
         "acquisitionClaimOwner" = p_claim_owner,
         "acquisitionClaimFence" = target."acquisitionClaimFence" + 1,
         "acquisitionHeartbeatAt" = clock_timestamp() AT TIME ZONE 'UTC',
         "acquisitionLeaseExpiresAt" = p_lease_expires_at
   WHERE target.id = locked_batch.id
   RETURNING target.id, target."conversionGeneration", target."acquisitionClaimFence"
        INTO "batchId", "conversionGeneration", "claimFence";
  RETURN NEXT;
END;
$$;
