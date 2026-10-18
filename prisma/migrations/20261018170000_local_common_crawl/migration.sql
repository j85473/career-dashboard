-- Additive only: preserve every prior score, candidate, receipt and source cursor.
ALTER TABLE "AtsDiscoveryAuditCandidate"
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourceIndexId" TEXT;

CREATE TABLE "AtsDiscoveryLocalScan" (
  "runId" TEXT NOT NULL,
  "indexId" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "plan" JSONB NOT NULL,
  "stats" JSONB NOT NULL,
  "nextBlock" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'running',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AtsDiscoveryLocalScan_pkey" PRIMARY KEY ("runId", "indexId", "planHash"),
  CONSTRAINT "AtsDiscoveryLocalScan_runId_fkey" FOREIGN KEY ("runId")
    REFERENCES "AtsDiscoveryAuditRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AtsDiscoveryLocalScan_nextBlock_check" CHECK ("nextBlock" >= 0)
);
CREATE INDEX "AtsDiscoveryLocalScan_runId_status_idx" ON "AtsDiscoveryLocalScan"("runId", "status");
