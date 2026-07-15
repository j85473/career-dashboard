-- Query indexes used by the dashboard and scoring queues.
BEGIN;

CREATE INDEX IF NOT EXISTS "Job_status_aimFitScore_idx" ON "Job"("status", "aimFitScore");
CREATE INDEX IF NOT EXISTS "Job_status_createdAt_idx" ON "Job"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Job_scoringStatus_status_aimFitScore_idx" ON "Job"("scoringStatus", "status", "aimFitScore");
CREATE INDEX IF NOT EXISTS "Job_luckyStatus_luckyAimFitScore_idx" ON "Job"("luckyStatus", "luckyAimFitScore");
CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_idx" ON "Job"("canonicalUrl");
CREATE INDEX IF NOT EXISTS "AtsCompany_status_nextCheckDate_idx" ON "AtsCompany"("status", "nextCheckDate");

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "luckyBatchId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "deepseekScoreAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "deepseekScoreError" TEXT;
CREATE INDEX IF NOT EXISTS "Job_luckyBatchId_idx" ON "Job"("luckyBatchId");
CREATE INDEX IF NOT EXISTS "Job_scoringStatus_deepseekScoreAttempts_idx" ON "Job"("scoringStatus", "deepseekScoreAttempts");

-- Append-only history for Context DB changes made by an evaluator.
CREATE TABLE IF NOT EXISTS "ContextRuleRevision" (
    "id" TEXT NOT NULL,
    "contextProfileId" TEXT NOT NULL,
    "previousRulesText" TEXT NOT NULL,
    "newRulesText" TEXT NOT NULL,
    "sourceJobIds" TEXT[] NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextRuleRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContextRuleRevision_createdAt_idx" ON "ContextRuleRevision"("createdAt");

-- One row per DeepSeek API attempt. This keeps cost/cache/error telemetry auditable.
CREATE TABLE IF NOT EXISTS "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requestId" TEXT,
    "batchSize" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "finishReason" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiUsageEvent_provider_createdAt_idx" ON "AiUsageEvent"("provider", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsageEvent_purpose_createdAt_idx" ON "AiUsageEvent"("purpose", "createdAt");

-- Append-only provenance for every score that is actually applied to a job.
CREATE TABLE IF NOT EXISTS "JobScoreEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "evaluationType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestId" TEXT,
    "aimFitScore" INTEGER,
    "experienceFitScore" INTEGER,
    "travelScore" INTEGER,
    "domainMatch" BOOLEAN,
    "requiredDomain" TEXT,
    "candidateDomain" TEXT,
    "requiredYearsInDomain" DOUBLE PRECISION,
    "candidateYearsInDomain" DOUBLE PRECISION,
    "passed" BOOLEAN NOT NULL,
    "aimReason" TEXT,
    "experienceReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobScoreEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "JobScoreEvent_jobId_createdAt_idx" ON "JobScoreEvent"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobScoreEvent_model_promptVersion_idx" ON "JobScoreEvent"("model", "promptVersion");

-- Source-level ingestion telemetry for throughput, filtering, and failure diagnosis.
CREATE TABLE IF NOT EXISTS "IngestionSourceRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seenCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "filteredCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IngestionSourceRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "IngestionSourceRun_source_createdAt_idx" ON "IngestionSourceRun"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "IngestionSourceRun_status_createdAt_idx" ON "IngestionSourceRun"("status", "createdAt");

COMMIT;
