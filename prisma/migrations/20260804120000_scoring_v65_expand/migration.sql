ALTER TABLE "JobScoreEvent"
  ADD COLUMN "qualificationBasis" TEXT,
  ADD COLUMN "mandatoryRequirementAssessments" JSONB;

ALTER TABLE "JobSourceObservation"
  ADD COLUMN "searchQuery" TEXT,
  ADD COLUMN "ingestionMode" TEXT,
  ADD COLUMN "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "IngestionSourceRun"
  ADD COLUMN "searchQuery" TEXT,
  ADD COLUMN "ingestionMode" TEXT;
