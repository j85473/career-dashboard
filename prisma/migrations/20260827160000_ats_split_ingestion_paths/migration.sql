-- Expand-only storage for independently supervised direct-ATS acquisition and
-- downstream persistence. Existing AtsCompany scheduling and history remain
-- intact; the compatibility lastCheckedAt column is not rewritten.
ALTER TABLE "AtsCompany"
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "lastRespondedAt" TIMESTAMP(3),
  ADD COLUMN "lastSynchronizedAt" TIMESTAMP(3),
  ADD COLUMN "lastProcessedAt" TIMESTAMP(3);

-- A short logical request lease coordinates platform-wide upstream limits
-- across the acquisition child and the batch-processing parent without holding
-- a database connection open during network I/O.
ALTER TABLE "ProviderCircuit"
  ADD COLUMN "requestLeaseToken" TEXT,
  ADD COLUMN "requestLeaseOwner" TEXT,
  ADD COLUMN "requestLeaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ProviderCircuit_requestLeaseToken_key"
  ON "ProviderCircuit"("requestLeaseToken");
CREATE INDEX "ProviderCircuit_requestLeaseExpiresAt_idx"
  ON "ProviderCircuit"("requestLeaseExpiresAt");

CREATE TABLE "AtsIngestionBatch" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'fetching',
  "payload" JSONB,
  "payloadHash" TEXT,
  "metadata" JSONB,
  "cursor" JSONB,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "pageCount" INTEGER NOT NULL DEFAULT 0,
  "jobCount" INTEGER NOT NULL DEFAULT 0,
  "insertedCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "filteredCount" INTEGER NOT NULL DEFAULT 0,
  "processingErrorCount" INTEGER NOT NULL DEFAULT 0,
  "processingAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "processingOffset" INTEGER NOT NULL DEFAULT 0,
  "nextProcessAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseOwner" TEXT,
  "leaseStartedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3),
  "synchronizedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsIngestionBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AtsIngestionBatch_slug_platform_fkey"
    FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AtsBoardCheckAttempt" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "batchId" TEXT,
  "outcome" TEXT NOT NULL DEFAULT 'running',
  "leaseOwner" TEXT,
  "heartbeatAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "httpStatus" INTEGER,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "pageCount" INTEGER NOT NULL DEFAULT 0,
  "jobCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contactedAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "synchronizedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsBoardCheckAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AtsBoardCheckAttempt_slug_platform_fkey"
    FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AtsBoardCheckAttempt_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "AtsIngestionBatch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AtsIngestionBatch_leaseToken_key"
  ON "AtsIngestionBatch"("leaseToken");
CREATE INDEX "AtsIngestionBatch_status_createdAt_idx"
  ON "AtsIngestionBatch"("status", "createdAt");
CREATE INDEX "AtsIngestionBatch_status_nextProcessAt_createdAt_idx"
  ON "AtsIngestionBatch"("status", "nextProcessAt", "createdAt");
CREATE INDEX "AtsIngestionBatch_slug_platform_status_createdAt_idx"
  ON "AtsIngestionBatch"("slug", "platform", "status", "createdAt");
CREATE INDEX "AtsIngestionBatch_leaseExpiresAt_idx"
  ON "AtsIngestionBatch"("leaseExpiresAt");
CREATE UNIQUE INDEX "AtsIngestionBatch_one_active_acquisition_per_board_key"
  ON "AtsIngestionBatch"("slug", "platform")
  WHERE status IN ('fetching', 'partial');
CREATE INDEX "AtsBoardCheckAttempt_slug_platform_startedAt_idx"
  ON "AtsBoardCheckAttempt"("slug", "platform", "startedAt");
CREATE INDEX "AtsBoardCheckAttempt_outcome_startedAt_idx"
  ON "AtsBoardCheckAttempt"("outcome", "startedAt");
CREATE INDEX "AtsBoardCheckAttempt_outcome_leaseExpiresAt_idx"
  ON "AtsBoardCheckAttempt"("outcome", "leaseExpiresAt");
CREATE UNIQUE INDEX "AtsBoardCheckAttempt_one_running_per_board_key"
  ON "AtsBoardCheckAttempt"("slug", "platform")
  WHERE outcome = 'running';
CREATE INDEX "AtsBoardCheckAttempt_batchId_idx"
  ON "AtsBoardCheckAttempt"("batchId");
CREATE INDEX "AtsBoardCheckAttempt_contactedAt_idx"
  ON "AtsBoardCheckAttempt"("contactedAt");
CREATE INDEX "AtsBoardCheckAttempt_respondedAt_idx"
  ON "AtsBoardCheckAttempt"("respondedAt");
CREATE INDEX "AtsBoardCheckAttempt_synchronizedAt_idx"
  ON "AtsBoardCheckAttempt"("synchronizedAt");
CREATE INDEX "AtsBoardCheckAttempt_processedAt_idx"
  ON "AtsBoardCheckAttempt"("processedAt");
CREATE INDEX "AtsBoardCheckAttempt_finishedAt_idx"
  ON "AtsBoardCheckAttempt"("finishedAt");
CREATE INDEX "AtsCompany_status_checkDay_lastAttemptedAt_idx"
  ON "AtsCompany"("status", "checkDay", "lastAttemptedAt");
