ALTER TABLE "AtsIngestionBatch"
  ADD COLUMN "operatorResetAt" TIMESTAMP(3),
  ADD COLUMN "operatorResetReason" TEXT,
  ADD COLUMN "operatorResetAbandonedItems" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD COLUMN "admissionResumeAt" TIMESTAMP(3);

ALTER TABLE "AtsIngestionBatch"
  ADD CONSTRAINT "AtsIngestionBatch_operator_reset_count_check"
    CHECK ("operatorResetAbandonedItems" >= 0);

CREATE INDEX "AtsIngestionBatch_operatorResetAt_status_idx"
  ON "AtsIngestionBatch"("operatorResetAt", "status");
