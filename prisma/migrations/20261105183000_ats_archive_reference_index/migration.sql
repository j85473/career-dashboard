-- PostgreSQL checks this reverse reference for each archived observation.
-- Without the index, retiring one batch repeatedly scans every retained item.
-- This changes no evidence, scores, or job lifecycle state.
CREATE INDEX "AtsIngestionItem_representativeObservationId_idx"
  ON "AtsIngestionItem"("representativeObservationId");

-- Match the existing observation/item vacuum policy so retired pages and
-- resolutions become reusable promptly instead of waiting for 20% churn.
ALTER TABLE "AtsIngestionPage" SET (
  autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=1000,
  autovacuum_analyze_scale_factor=0.01, autovacuum_analyze_threshold=1000
);
ALTER TABLE "AtsListingObservationResolution" SET (
  autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=1000,
  autovacuum_analyze_scale_factor=0.01, autovacuum_analyze_threshold=1000
);
