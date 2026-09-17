-- A full ATS discovery audit must be restartable and independently provable.
-- The weekly cursor remains untouched; these tables record the audit target,
-- per-pattern checkpoints, per-index completion receipts, and every candidate
-- before the crawler advances beyond the page where it found that candidate.
CREATE TABLE "AtsDiscoveryAuditRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "targetIndexId" TEXT NOT NULL,
    "indexCount" INTEGER NOT NULL,
    "patternCount" INTEGER NOT NULL,
    "completedPatterns" INTEGER NOT NULL DEFAULT 0,
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "candidatesQueued" INTEGER NOT NULL DEFAULT 0,
    "boardsCreated" INTEGER NOT NULL DEFAULT 0,
    "existingBoards" INTEGER NOT NULL DEFAULT 0,
    "retiredBoards" INTEGER NOT NULL DEFAULT 0,
    "parkedBoards" INTEGER NOT NULL DEFAULT 0,
    "unresolvedBoards" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AtsDiscoveryAuditRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsDiscoveryAuditCheckpoint" (
    "runId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "indexId" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "indexPagesRead" INTEGER NOT NULL DEFAULT 0,
    "indexRecordsRead" INTEGER NOT NULL DEFAULT 0,
    "indexCandidatesQueued" INTEGER NOT NULL DEFAULT 0,
    "completedThrough" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtsDiscoveryAuditCheckpoint_pkey" PRIMARY KEY ("runId", "platform", "pattern")
);

CREATE TABLE "AtsDiscoveryAuditIndexReceipt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "indexId" TEXT NOT NULL,
    "pagesRead" INTEGER NOT NULL,
    "recordsRead" INTEGER NOT NULL,
    "candidatesQueued" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtsDiscoveryAuditIndexReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsDiscoveryAuditCandidate" (
    "runId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "normalizedSlug" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtsDiscoveryAuditCandidate_pkey" PRIMARY KEY ("runId", "platform", "slug")
);

CREATE INDEX "AtsDiscoveryAuditRun_status_updatedAt_idx" ON "AtsDiscoveryAuditRun"("status", "updatedAt");
CREATE INDEX "AtsDiscoveryAuditCheckpoint_runId_completedThrough_idx" ON "AtsDiscoveryAuditCheckpoint"("runId", "completedThrough");
CREATE UNIQUE INDEX "AtsDiscoveryAuditIndexReceipt_runId_platform_pattern_indexId_key" ON "AtsDiscoveryAuditIndexReceipt"("runId", "platform", "pattern", "indexId");
CREATE INDEX "AtsDiscoveryAuditIndexReceipt_runId_platform_pattern_idx" ON "AtsDiscoveryAuditIndexReceipt"("runId", "platform", "pattern");
CREATE INDEX "AtsDiscoveryAuditCandidate_runId_platform_normalizedSlug_idx" ON "AtsDiscoveryAuditCandidate"("runId", "platform", "normalizedSlug");
CREATE INDEX "AtsDiscoveryAuditCandidate_runId_status_nextAttemptAt_idx" ON "AtsDiscoveryAuditCandidate"("runId", "status", "nextAttemptAt");

ALTER TABLE "AtsDiscoveryAuditCheckpoint" ADD CONSTRAINT "AtsDiscoveryAuditCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AtsDiscoveryAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AtsDiscoveryAuditIndexReceipt" ADD CONSTRAINT "AtsDiscoveryAuditIndexReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AtsDiscoveryAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AtsDiscoveryAuditCandidate" ADD CONSTRAINT "AtsDiscoveryAuditCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AtsDiscoveryAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
