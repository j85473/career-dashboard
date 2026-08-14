-- Expand-only lifecycle metadata for durable ingestion tasks. Existing rows
-- intentionally retain the compatible active/search defaults until the
-- guarded catalog reconciliation command previews and applies classification.
ALTER TABLE "IngestionTask"
  ADD COLUMN "taskKind" TEXT NOT NULL DEFAULT 'search',
  ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "retiredAt" TIMESTAMP(3);

CREATE INDEX "IngestionTask_taskKind_lifecycleStatus_status_nextRunAt_idx"
  ON "IngestionTask"("taskKind", "lifecycleStatus", "status", "nextRunAt");
