-- One unavailable Common Crawl page must not idle the whole exhaustive audit.
-- The exact page remains in the existing checkpoint; these fields only make
-- its retry delay durable while the single-request worker visits other URL
-- patterns and validates already queued candidates.
ALTER TABLE "AtsDiscoveryAuditCheckpoint"
ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastError" TEXT;

CREATE INDEX "AtsDiscoveryAuditCheckpoint_runId_nextAttemptAt_idx"
ON "AtsDiscoveryAuditCheckpoint"("runId", "nextAttemptAt");
