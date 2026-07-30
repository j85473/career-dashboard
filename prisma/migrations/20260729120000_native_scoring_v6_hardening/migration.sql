BEGIN;

ALTER TABLE "JobScoreEvent" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "schemaVersion" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "chunkId" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "promptHash" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "evidenceHash" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "inputHash" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN "evidenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX "JobScoreEvent_idempotencyKey_key" ON "JobScoreEvent"("idempotencyKey");

CREATE INDEX "JobScoreEvent_requestId_evaluationType_idx" ON "JobScoreEvent"("requestId", "evaluationType");

ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_score_range_check" CHECK (
    ("aimFitScore" IS NULL OR "aimFitScore" BETWEEN 0 AND 100)
    AND ("experienceFitScore" IS NULL OR "experienceFitScore" BETWEEN 0 AND 100)
    AND ("travelScore" IS NULL OR "travelScore" BETWEEN 0 AND 100)
) NOT VALID;

COMMIT;
