-- Add classifications for new retry decisions. Existing payloads, holds,
-- retry dates, job cards and scores are unchanged; no backfill is required.
ALTER TABLE "AtsIngestionItem" ADD COLUMN "retryCode" TEXT, ADD COLUMN "retryScope" TEXT;
ALTER TABLE "AtsIngestionSegment" ADD COLUMN "retryCode" TEXT, ADD COLUMN "retryScope" TEXT;
