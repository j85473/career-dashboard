-- Preserve all prior audit receipts, candidates, and source cursors.
ALTER TABLE "AtsDiscoveryAuditCheckpoint"
  ADD COLUMN "athenaRequestToken" TEXT;
