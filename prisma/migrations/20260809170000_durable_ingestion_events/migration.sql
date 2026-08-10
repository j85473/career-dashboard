-- Expand-only durable ingestion controls and immutable pipeline evidence.
-- No production rows are rewritten by this migration. Legacy file state and
-- JobStatusHistory remain readable during the rollout.
BEGIN;

CREATE TABLE IF NOT EXISTS "IngestionTask" (
    "id" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "queryFamily" TEXT,
    "searchQuery" TEXT,
    "geoLane" TEXT NOT NULL,
    "ingestionMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "watermarkAt" TIMESTAMP(3),
    "cursor" JSONB,
    "leaseToken" TEXT,
    "leaseOwner" TEXT,
    "leaseStartedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "seenCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "filteredCount" INTEGER NOT NULL DEFAULT 0,
    "processingErrorCount" INTEGER NOT NULL DEFAULT 0,
    "providerErrorCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "IngestionTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IngestionTask_taskKey_key" ON "IngestionTask"("taskKey");
CREATE UNIQUE INDEX IF NOT EXISTS "IngestionTask_leaseToken_key" ON "IngestionTask"("leaseToken");
CREATE INDEX IF NOT EXISTS "IngestionTask_status_nextRunAt_idx" ON "IngestionTask"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "IngestionTask_source_nextRunAt_idx" ON "IngestionTask"("source", "nextRunAt");
CREATE INDEX IF NOT EXISTS "IngestionTask_leaseExpiresAt_idx" ON "IngestionTask"("leaseExpiresAt");

CREATE TABLE IF NOT EXISTS "ProviderCircuit" (
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'closed',
    "openUntil" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "dailyLimit" INTEGER,
    "monthlyLimit" INTEGER,
    "dailyUsed" INTEGER NOT NULL DEFAULT 0,
    "monthlyUsed" INTEGER NOT NULL DEFAULT 0,
    "budgetDay" TEXT,
    "budgetMonth" TEXT,
    "lastError" TEXT,
    "lastFailureAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "ProviderCircuit_pkey" PRIMARY KEY ("provider")
);

CREATE INDEX IF NOT EXISTS "ProviderCircuit_state_openUntil_idx" ON "ProviderCircuit"("state", "openUntil");

CREATE TABLE IF NOT EXISTS "ProviderIncident" (
    "id" TEXT NOT NULL,
    "incidentKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "affectedQueryCount" INTEGER NOT NULL DEFAULT 1,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "ProviderIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderIncident_incidentKey_key" ON "ProviderIncident"("incidentKey");
CREATE INDEX IF NOT EXISTS "ProviderIncident_status_lastSeenAt_idx" ON "ProviderIncident"("status", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "ProviderIncident_provider_lastSeenAt_idx" ON "ProviderIncident"("provider", "lastSeenAt");

CREATE TABLE IF NOT EXISTS "ProviderIncidentAffectedTask" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "queryFamily" TEXT,
    "geoLane" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "ProviderIncidentAffectedTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderIncidentAffectedTask_incidentId_fkey"
        FOREIGN KEY ("incidentId") REFERENCES "ProviderIncident"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderIncidentAffectedTask_incidentId_taskKey_key"
ON "ProviderIncidentAffectedTask"("incidentId", "taskKey");
CREATE INDEX IF NOT EXISTS "ProviderIncidentAffectedTask_incidentId_firstSeenAt_idx"
ON "ProviderIncidentAffectedTask"("incidentId", "firstSeenAt");

CREATE TABLE IF NOT EXISTS "ContextRule" (
    "id" TEXT NOT NULL,
    "contextProfileId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "ruleText" TEXT NOT NULL,
    "sourceDecisionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "lastConfirmedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,
    "provenance" JSONB,
    CONSTRAINT "ContextRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContextRule_contextProfileId_fkey"
        FOREIGN KEY ("contextProfileId") REFERENCES "ContextProfile"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ContextRule_ruleKey_key" ON "ContextRule"("ruleKey");
CREATE INDEX IF NOT EXISTS "ContextRule_active_dimension_idx" ON "ContextRule"("active", "dimension");
CREATE INDEX IF NOT EXISTS "ContextRule_contextProfileId_idx" ON "ContextRule"("contextProfileId");

CREATE TABLE IF NOT EXISTS "JobPipelineEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "jobId" TEXT,
    "taskId" TEXT,
    "eventType" TEXT NOT NULL,
    "stage" TEXT,
    "source" TEXT,
    "sourceId" TEXT,
    "queryFamily" TEXT,
    "geoLane" TEXT,
    "details" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "JobPipelineEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobPipelineEvent_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JobPipelineEvent_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "IngestionTask"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobPipelineEvent_eventKey_key" ON "JobPipelineEvent"("eventKey");
CREATE INDEX IF NOT EXISTS "JobPipelineEvent_eventType_occurredAt_idx" ON "JobPipelineEvent"("eventType", "occurredAt");
CREATE INDEX IF NOT EXISTS "JobPipelineEvent_jobId_occurredAt_idx" ON "JobPipelineEvent"("jobId", "occurredAt");
CREATE INDEX IF NOT EXISTS "JobPipelineEvent_taskId_occurredAt_idx" ON "JobPipelineEvent"("taskId", "occurredAt");
CREATE INDEX IF NOT EXISTS "JobPipelineEvent_source_occurredAt_idx" ON "JobPipelineEvent"("source", "occurredAt");

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "identityFingerprint" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "postingIdentity" TEXT;
CREATE INDEX IF NOT EXISTS "Job_identityFingerprint_idx" ON "Job"("identityFingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "Job_postingIdentity_key" ON "Job"("postingIdentity");

ALTER TABLE "JobSourceObservation" ADD COLUMN IF NOT EXISTS "queryFamily" TEXT;
ALTER TABLE "JobSourceObservation" ADD COLUMN IF NOT EXISTS "geoLane" TEXT;
ALTER TABLE "JobSourceObservation" ADD COLUMN IF NOT EXISTS "windowStart" TIMESTAMP(3);
ALTER TABLE "JobSourceObservation" ADD COLUMN IF NOT EXISTS "windowEnd" TIMESTAMP(3);
ALTER TABLE "JobSourceObservation" ADD COLUMN IF NOT EXISTS "taskId" TEXT;
ALTER TABLE "JobSourceObservation" ADD CONSTRAINT "JobSourceObservation_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "IngestionTask"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "JobSourceObservation_taskId_observedAt_idx" ON "JobSourceObservation"("taskId", "observedAt");
CREATE INDEX IF NOT EXISTS "JobSourceObservation_geoLane_observedAt_idx" ON "JobSourceObservation"("geoLane", "observedAt");

ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "taskId" TEXT;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "providerIncidentId" TEXT;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "queryFamily" TEXT;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "geoLane" TEXT;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "windowStart" TIMESTAMP(3);
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "windowEnd" TIMESTAMP(3);
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "watermarkAt" TIMESTAMP(3);
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "checkpoint" JSONB;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "processingErrorCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "requestErrorCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IngestionSourceRun" ADD COLUMN IF NOT EXISTS "reconciled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IngestionSourceRun" ADD CONSTRAINT "IngestionSourceRun_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "IngestionTask"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IngestionSourceRun" ADD CONSTRAINT "IngestionSourceRun_providerIncidentId_fkey"
    FOREIGN KEY ("providerIncidentId") REFERENCES "ProviderIncident"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "IngestionSourceRun_taskId_createdAt_idx" ON "IngestionSourceRun"("taskId", "createdAt");
CREATE INDEX IF NOT EXISTS "IngestionSourceRun_geoLane_createdAt_idx" ON "IngestionSourceRun"("geoLane", "createdAt");

ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "staleAt" TIMESTAMP(3);
ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "staleReason" TEXT;
CREATE INDEX IF NOT EXISTS "JobScoreEvent_staleAt_createdAt_idx" ON "JobScoreEvent"("staleAt", "createdAt");

COMMIT;
