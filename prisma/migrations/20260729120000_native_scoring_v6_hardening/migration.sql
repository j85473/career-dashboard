BEGIN;

ALTER TABLE "JobScoreEvent"
    ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
    ADD COLUMN IF NOT EXISTS "schemaVersion" TEXT,
    ADD COLUMN IF NOT EXISTS "chunkId" TEXT,
    ADD COLUMN IF NOT EXISTS "promptHash" TEXT,
    ADD COLUMN IF NOT EXISTS "evidenceHash" TEXT,
    ADD COLUMN IF NOT EXISTS "inputHash" TEXT,
    ADD COLUMN IF NOT EXISTS "evidenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS "JobScoreEvent_idempotencyKey_key"
    ON "JobScoreEvent"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "JobScoreEvent_requestId_evaluationType_idx"
    ON "JobScoreEvent"("requestId", "evaluationType");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobScoreEvent_score_range_check'
    ) THEN
        ALTER TABLE "JobScoreEvent"
            ADD CONSTRAINT "JobScoreEvent_score_range_check"
            CHECK (
                ("aimFitScore" IS NULL OR "aimFitScore" BETWEEN 0 AND 100)
                AND ("experienceFitScore" IS NULL OR "experienceFitScore" BETWEEN 0 AND 100)
                AND ("travelScore" IS NULL OR "travelScore" BETWEEN 0 AND 100)
            ) NOT VALID;
    END IF;
END
$$;

COMMIT;
