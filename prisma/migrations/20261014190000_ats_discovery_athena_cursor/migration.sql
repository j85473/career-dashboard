-- Athena result pagination is durable audit work. These nullable, additive
-- fields preserve every existing direct-API checkpoint until the worker is
-- explicitly switched, and never alter candidate, receipt, or score history.
ALTER TABLE "AtsDiscoveryAuditCheckpoint"
  ADD COLUMN "athenaExecutionId" TEXT,
  ADD COLUMN "athenaNextToken" TEXT,
  ADD COLUMN "athenaResultsComplete" BOOLEAN NOT NULL DEFAULT false;
