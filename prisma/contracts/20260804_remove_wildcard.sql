DROP INDEX IF EXISTS "Job_luckyStatus_idx";
DROP INDEX IF EXISTS "Job_luckyStatus_luckyAimFitScore_idx";
DROP INDEX IF EXISTS "Job_luckyBatchId_idx";

ALTER TABLE "Job"
  DROP COLUMN IF EXISTS "luckyAimFitScore",
  DROP COLUMN IF EXISTS "luckyFitCategory",
  DROP COLUMN IF EXISTS "luckyFitScore",
  DROP COLUMN IF EXISTS "luckyPassReason",
  DROP COLUMN IF EXISTS "luckyScoreAttempts",
  DROP COLUMN IF EXISTS "luckyScoreError",
  DROP COLUMN IF EXISTS "luckyStatus",
  DROP COLUMN IF EXISTS "luckyBatchId";

ALTER TABLE "NativeScoringRequest"
  DROP COLUMN IF EXISTS "wildcardJobs",
  DROP COLUMN IF EXISTS "wildcardRuns",
  DROP COLUMN IF EXISTS "wildcardBatchId";

DROP TABLE IF EXISTS "WildcardProfile";
DROP TABLE IF EXISTS "UsedWildcardQuery";
