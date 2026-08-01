BEGIN;

-- Durable, single-flight native Antigravity scoring requests.
CREATE TABLE IF NOT EXISTS "NativeScoringRequest" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT NOT NULL,
    "progress" TEXT NOT NULL DEFAULT 'Waiting for the local Antigravity runner.',
    "error" TEXT,
    "workerId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "contextJobs" INTEGER NOT NULL DEFAULT 0,
    "standardJobs" INTEGER NOT NULL DEFAULT 0,
    "wildcardJobs" INTEGER NOT NULL DEFAULT 0,
    "contextRuns" INTEGER NOT NULL DEFAULT 0,
    "standardRuns" INTEGER NOT NULL DEFAULT 0,
    "wildcardRuns" INTEGER NOT NULL DEFAULT 0,
    "contextBatchId" TEXT,
    "standardBatchId" TEXT,
    "wildcardBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativeScoringRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NativeScoringRequest_active_key_check" CHECK ("activeKey" IS NULL OR "activeKey" = 'global'),
    CONSTRAINT "NativeScoringRequest_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT "NativeScoringRequest_phase_check" CHECK ("phase" IN (
        'queued',
        'context_preparing', 'context_scoring',
        'standard_preparing', 'standard_scoring',
        'wildcard_preparing', 'wildcard_scoring',
        'completed'
    )),
    CONSTRAINT "NativeScoringRequest_nonnegative_counts_check" CHECK (
        "attempt" >= 0
        AND "contextJobs" >= 0 AND "standardJobs" >= 0 AND "wildcardJobs" >= 0
        AND "contextRuns" >= 0 AND "standardRuns" >= 0 AND "wildcardRuns" >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "NativeScoringRequest_activeKey_key"
ON "NativeScoringRequest"("activeKey");
CREATE INDEX IF NOT EXISTS "NativeScoringRequest_status_createdAt_idx"
ON "NativeScoringRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "NativeScoringRequest_updatedAt_idx"
ON "NativeScoringRequest"("updatedAt");

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "contextBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "Job_contextBatchId_idx" ON "Job"("contextBatchId");

ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "schemaVersion" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "chunkId" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "inputHash" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "contextHash" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "manifestHash" TEXT;
ALTER TABLE "ContextRuleRevision" ADD COLUMN IF NOT EXISTS "resultHash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ContextRuleRevision_idempotencyKey_key"
ON "ContextRuleRevision"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "ContextRuleRevision_batchId_idx"
ON "ContextRuleRevision"("batchId");

ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "contextHash" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "contextProfileUpdatedAt" TIMESTAMP(3);
ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "manifestHash" TEXT;
ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "resultHash" TEXT;
CREATE INDEX IF NOT EXISTS "JobScoreEvent_batchId_idx" ON "JobScoreEvent"("batchId");

COMMIT;
