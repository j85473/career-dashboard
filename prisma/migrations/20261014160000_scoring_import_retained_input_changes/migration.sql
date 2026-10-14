-- Retain an exact returned result when its card changed after export.
-- Existing cards, scores, and leases are untouched.
ALTER TABLE "ScoringBatchItem"
  ADD COLUMN "retainedInputChange" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "ScoringBatchItem_retained_input_check"
    CHECK (NOT "retainedInputChange" OR (
      "status" = 'released'
      AND "acceptedResultHash" IS NOT NULL
      AND "acceptedResultSnapshot" IS NOT NULL
      AND "importedScoreEventId" IS NULL
    ));
