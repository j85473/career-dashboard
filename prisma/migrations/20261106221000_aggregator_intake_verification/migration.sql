CREATE TABLE "AggregatorIntakeCandidate" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "payload" JSONB,
  "context" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT NOT NULL,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "jobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AggregatorIntakeCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AggregatorIntakeCandidate_source_sourceId_key" ON "AggregatorIntakeCandidate"("source", "sourceId");
CREATE UNIQUE INDEX "AggregatorIntakeCandidate_leaseToken_key" ON "AggregatorIntakeCandidate"("leaseToken");
CREATE INDEX "AggregatorIntakeCandidate_status_nextAttemptAt_idx" ON "AggregatorIntakeCandidate"("status", "nextAttemptAt");
CREATE INDEX "AggregatorIntakeCandidate_leaseExpiresAt_idx" ON "AggregatorIntakeCandidate"("leaseExpiresAt");
