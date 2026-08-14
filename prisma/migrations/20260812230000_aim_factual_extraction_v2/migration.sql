-- Forward-only Aim v2 factual-extraction and bounded failure provenance.
-- Historical v1 batches, score events, and cleaned artifacts remain unchanged.

ALTER TABLE "ScoringBatch"
  ADD COLUMN "questionRegistryHash" TEXT,
  ADD COLUMN "promptContractHash" TEXT,
  ADD COLUMN "responseContractHash" TEXT,
  ADD COLUMN "runnerProtocolHash" TEXT,
  ADD COLUMN "packetStrategyHash" TEXT,
  ADD COLUMN "scoringPolicyHash" TEXT,
  ADD COLUMN "anonymizationPolicyHash" TEXT,
  ADD COLUMN "resultBuilderSemanticVersion" TEXT;

ALTER TABLE "ScoringBatchItem"
  ADD COLUMN "latestPacketPlanHash" TEXT,
  ADD COLUMN "aimFactualExtractionId" TEXT,
  ADD COLUMN "manualRetryOfFailureReceiptId" TEXT,
  ADD COLUMN "manualRetryReason" TEXT,
  ADD CONSTRAINT "ScoringBatchItem_manual_retry_reason_check"
    CHECK ("manualRetryReason" IS NULL OR (char_length(btrim("manualRetryReason")) BETWEEN 1 AND 500));

ALTER TABLE "JobScoreEvent"
  ADD COLUMN "aimFactualExtractionId" TEXT,
  ADD COLUMN "questionRegistryHash" TEXT,
  ADD COLUMN "scoringPolicyHash" TEXT,
  ADD COLUMN "resultBuilderSemanticVersion" TEXT,
  ADD COLUMN "scoringIdentity" TEXT,
  ADD COLUMN "semanticResultHash" TEXT,
  ADD COLUMN "lifecyclePriorStatus" TEXT,
  ADD COLUMN "lifecycleApplied" BOOLEAN;

CREATE TABLE "AimFactualExtraction" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "extractionIdentity" TEXT NOT NULL,
    "factualVectorHash" TEXT NOT NULL,
    "sourceJdHash" TEXT NOT NULL,
    "trustedMetadataHash" TEXT NOT NULL,
    "questionRegistryVersion" TEXT NOT NULL,
    "questionRegistryHash" TEXT NOT NULL,
    "promptContractVersion" TEXT NOT NULL,
    "promptContractHash" TEXT NOT NULL,
    "responseContractVersion" TEXT NOT NULL,
    "responseContractHash" TEXT NOT NULL,
    "runnerProtocolVersion" TEXT NOT NULL,
    "runnerProtocolHash" TEXT NOT NULL,
    "packetStrategyVersion" TEXT NOT NULL,
    "packetStrategyHash" TEXT NOT NULL,
    "canonicalizationVersion" TEXT NOT NULL,
    "anonymizationPolicyVersion" TEXT NOT NULL,
    "anonymizationPolicyHash" TEXT NOT NULL,
    "extractorSemanticVersion" TEXT NOT NULL,
    "latestPacketPlanHash" TEXT,
    "extractionSnapshot" JSONB NOT NULL,
    "workerProvenance" JSONB NOT NULL,
    "producedByBatchItemId" TEXT NOT NULL,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AimFactualExtraction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AimFactualExtraction_schema_check" CHECK ("schemaVersion" = 'career-dashboard-aim-factual-vector-v1'),
    CONSTRAINT "AimFactualExtraction_scope_check" CHECK ("scope" IN ('stage1', 'compensation_preflight', 'complete'))
);

CREATE TABLE "AimScoringFailureReceipt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "producedByBatchItemId" TEXT NOT NULL,
    "sourceIdentity" TEXT NOT NULL,
    "extractionIdentity" TEXT,
    "inputHash" TEXT NOT NULL,
    "failureResolutionIdentity" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "runnerProtocolHash" TEXT NOT NULL,
    "failureCode" TEXT NOT NULL,
    "permanence" TEXT NOT NULL,
    "retrySeriesKey" TEXT NOT NULL,
    "suppressionKey" TEXT NOT NULL,
    "suppressionActive" BOOLEAN NOT NULL,
    "seriesOrdinal" INTEGER NOT NULL,
    "failureReceiptHash" TEXT NOT NULL,
    "failureSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedReason" TEXT,
    "clearedActor" TEXT,
    CONSTRAINT "AimScoringFailureReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AimScoringFailureReceipt_code_check" CHECK ("failureCode" IN (
      'source_unusable', 'model_input_privacy_violation', 'input_contract_limit_exceeded',
      'model_context_limit_exceeded', 'worker_invocation_failed', 'packet_invalid',
      'evidence_invalid', 'fact_extraction_conflict', 'extraction_identity_vector_conflict'
    )),
    CONSTRAINT "AimScoringFailureReceipt_permanence_check" CHECK ("permanence" IN ('transient', 'input_bound')),
    CONSTRAINT "AimScoringFailureReceipt_series_ordinal_check" CHECK ("seriesOrdinal" > 0),
    CONSTRAINT "AimScoringFailureReceipt_clear_check" CHECK (
      ("clearedAt" IS NULL AND "clearedReason" IS NULL AND "clearedActor" IS NULL)
      OR ("clearedAt" IS NOT NULL AND "clearedReason" IS NOT NULL AND "clearedActor" IS NOT NULL AND "suppressionActive" = FALSE)
    )
);

CREATE UNIQUE INDEX "AimFactualExtraction_producedByBatchItemId_key" ON "AimFactualExtraction"("producedByBatchItemId");
CREATE UNIQUE INDEX "AimFactualExtraction_jobId_extractionIdentity_scope_key" ON "AimFactualExtraction"("jobId", "extractionIdentity", "scope");
CREATE INDEX "AimFactualExtraction_jobId_createdAt_idx" ON "AimFactualExtraction"("jobId", "createdAt");
CREATE INDEX "AimFactualExtraction_jobId_staleAt_idx" ON "AimFactualExtraction"("jobId", "staleAt");
CREATE INDEX "AimFactualExtraction_extractionIdentity_idx" ON "AimFactualExtraction"("extractionIdentity");
CREATE INDEX "AimFactualExtraction_factualVectorHash_idx" ON "AimFactualExtraction"("factualVectorHash");

CREATE UNIQUE INDEX "AimScoringFailureReceipt_producedByBatchItemId_key" ON "AimScoringFailureReceipt"("producedByBatchItemId");
CREATE UNIQUE INDEX "AimScoringFailureReceipt_failureReceiptHash_key" ON "AimScoringFailureReceipt"("failureReceiptHash");
CREATE UNIQUE INDEX "AimScoringFailureReceipt_active_suppression_key"
  ON "AimScoringFailureReceipt"("suppressionKey")
  WHERE "suppressionActive" = TRUE AND "clearedAt" IS NULL;
CREATE INDEX "AimScoringFailureReceipt_jobId_createdAt_idx" ON "AimScoringFailureReceipt"("jobId", "createdAt");
CREATE INDEX "AimScoringFailureReceipt_jobId_retrySeriesKey_createdAt_idx" ON "AimScoringFailureReceipt"("jobId", "retrySeriesKey", "createdAt");
CREATE INDEX "AimScoringFailureReceipt_suppressionActive_clearedAt_idx" ON "AimScoringFailureReceipt"("suppressionActive", "clearedAt");

CREATE INDEX "ScoringBatchItem_aimFactualExtractionId_idx" ON "ScoringBatchItem"("aimFactualExtractionId");
CREATE INDEX "ScoringBatchItem_manualRetryOfFailureReceiptId_idx" ON "ScoringBatchItem"("manualRetryOfFailureReceiptId");
CREATE INDEX "JobScoreEvent_aimFactualExtractionId_idx" ON "JobScoreEvent"("aimFactualExtractionId");
CREATE INDEX "JobScoreEvent_scoringIdentity_idx" ON "JobScoreEvent"("scoringIdentity");
CREATE UNIQUE INDEX "JobScoreEvent_jobId_scoringIdentity_v2_key"
  ON "JobScoreEvent"("jobId", "scoringIdentity")
  WHERE "scoringIdentity" IS NOT NULL;

ALTER TABLE "AimFactualExtraction" ADD CONSTRAINT "AimFactualExtraction_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AimFactualExtraction" ADD CONSTRAINT "AimFactualExtraction_producedByBatchItemId_fkey"
  FOREIGN KEY ("producedByBatchItemId") REFERENCES "ScoringBatchItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AimScoringFailureReceipt" ADD CONSTRAINT "AimScoringFailureReceipt_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AimScoringFailureReceipt" ADD CONSTRAINT "AimScoringFailureReceipt_producedByBatchItemId_fkey"
  FOREIGN KEY ("producedByBatchItemId") REFERENCES "ScoringBatchItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_aimFactualExtractionId_fkey"
  FOREIGN KEY ("aimFactualExtractionId") REFERENCES "AimFactualExtraction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_manualRetryOfFailureReceiptId_fkey"
  FOREIGN KEY ("manualRetryOfFailureReceiptId") REFERENCES "AimScoringFailureReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_aimFactualExtractionId_fkey"
  FOREIGN KEY ("aimFactualExtractionId") REFERENCES "AimFactualExtraction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
