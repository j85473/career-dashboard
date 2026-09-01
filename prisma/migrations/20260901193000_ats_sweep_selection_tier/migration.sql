-- Preserve the scheduler bucket that admitted each board so operator progress
-- remains truthful after a successful recovery changes the board back to
-- active. Historical receipts remain explicitly unclassified; no prior work
-- is reinterpreted or rewritten.
ALTER TABLE "AtsEndpointSweepReceipt"
  ADD COLUMN "selectionTier" TEXT NOT NULL DEFAULT 'unclassified';

ALTER TABLE "AtsEndpointSweepReceipt"
  ADD CONSTRAINT "AtsEndpointSweepReceipt_selection_tier_check"
  CHECK ("selectionTier" IN ('unclassified', 'today', 'backlog', 'cooldown'));

CREATE INDEX "AtsEndpointSweepReceipt_selectionTier_processedAt_idx"
  ON "AtsEndpointSweepReceipt"("selectionTier", "processedAt");
