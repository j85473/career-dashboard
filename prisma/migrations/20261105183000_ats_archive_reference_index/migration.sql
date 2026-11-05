-- PostgreSQL checks this reverse reference for each archived observation.
-- Without the index, retiring one batch repeatedly scans every retained item.
-- This changes no evidence, scores, or job lifecycle state.
CREATE INDEX "AtsIngestionItem_representativeObservationId_idx"
  ON "AtsIngestionItem"("representativeObservationId");
