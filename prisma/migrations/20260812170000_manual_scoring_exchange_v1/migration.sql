-- Manual two-stage scoring exchange. Historical native-scoring tables and rows
-- are intentionally preserved.

-- Retire only stale exclusivity keys on already-failed historical requests.
-- Request rows, payloads, statuses, and timestamps remain intact, and queued or
-- running requests are deliberately untouched.
UPDATE "NativeScoringRequest"
SET "activeKey" = NULL
WHERE status = 'failed' AND "activeKey" IS NOT NULL;

CREATE TABLE "ScoringBatch" (
    "id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'exported',
    "schemaVersion" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "exportHash" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "preferenceHash" TEXT,
    "employerOverridesHash" TEXT,
    "resumeHash" TEXT,
    "evidenceHash" TEXT,
    "inputVersionsHash" TEXT NOT NULL,
    "manifestSnapshot" JSONB NOT NULL,
    "exportJson" TEXT NOT NULL,
    "exportByteLength" INTEGER NOT NULL,
    "acceptedResultHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "supersededReason" TEXT,
    CONSTRAINT "ScoringBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScoringBatch_stage_check" CHECK ("stage" IN ('aim', 'experience')),
    CONSTRAINT "ScoringBatch_status_check" CHECK ("status" IN ('exported', 'completed', 'released', 'superseded')),
    CONSTRAINT "ScoringBatch_export_length_check" CHECK ("exportByteLength" > 0 AND "exportByteLength" <= 33554432),
    CONSTRAINT "ScoringBatch_completion_check" CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL)),
    CONSTRAINT "ScoringBatch_release_check" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL)),
    CONSTRAINT "ScoringBatch_supersession_check" CHECK (("status" = 'superseded') = ("supersededAt" IS NOT NULL))
);

CREATE TABLE "ScoringBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'leased',
    "submittedUpdatedAt" TIMESTAMP(3) NOT NULL,
    "sourceJdHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "sourceAimEventId" TEXT,
    "cleanedArtifactId" TEXT,
    "acceptedResultHash" TEXT,
    "acceptedResultSnapshot" JSONB,
    "importedScoreEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    CONSTRAINT "ScoringBatchItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScoringBatchItem_stage_check" CHECK ("stage" IN ('aim', 'experience')),
    CONSTRAINT "ScoringBatchItem_status_check" CHECK ("status" IN ('leased', 'imported', 'released')),
    CONSTRAINT "ScoringBatchItem_ordinal_check" CHECK ("ordinal" >= 0 AND "ordinal" < 50),
    CONSTRAINT "ScoringBatchItem_import_check" CHECK (("status" = 'imported') = ("importedAt" IS NOT NULL)),
    CONSTRAINT "ScoringBatchItem_release_check" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL))
);

CREATE TABLE "JobScoringArtifact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "cleanerVersion" TEXT NOT NULL,
    "sourceJdHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "cleanedText" TEXT NOT NULL,
    "removedSpans" JSONB NOT NULL,
    "coverageAudit" JSONB NOT NULL,
    "repairHistory" JSONB NOT NULL,
    "producedByBatchItemId" TEXT NOT NULL,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobScoringArtifact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobScoringArtifact_kind_check" CHECK ("kind" = 'cleaned_jd')
);

ALTER TABLE "JobScoreEvent"
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "batchItemId" TEXT,
  ADD COLUMN "sourceAimEventId" TEXT,
  ADD COLUMN "cleanedJdArtifactId" TEXT,
  ADD COLUMN "decisionCode" TEXT,
  ADD COLUMN "aimAssessments" JSONB,
  ADD COLUMN "travelAssessment" JSONB,
  ADD COLUMN "compensationAssessment" JSONB,
  ADD COLUMN "preferredRequirementAssessments" JSONB,
  ADD COLUMN "inputBindings" JSONB,
  ADD COLUMN "lifecycleProjection" TEXT,
  ADD COLUMN "workerProvenance" JSONB;

CREATE UNIQUE INDEX "ScoringBatch_exportHash_key" ON "ScoringBatch"("exportHash");
CREATE UNIQUE INDEX "ScoringBatch_manifestHash_key" ON "ScoringBatch"("manifestHash");
CREATE INDEX "ScoringBatch_stage_status_createdAt_idx" ON "ScoringBatch"("stage", "status", "createdAt");
CREATE INDEX "ScoringBatch_expiresAt_idx" ON "ScoringBatch"("expiresAt");
CREATE UNIQUE INDEX "ScoringBatch_one_nonterminal_per_stage" ON "ScoringBatch"("stage") WHERE "status" IN ('exported', 'superseded');

CREATE UNIQUE INDEX "ScoringBatchItem_batchId_ordinal_key" ON "ScoringBatchItem"("batchId", "ordinal");
CREATE UNIQUE INDEX "ScoringBatchItem_batchId_jobId_key" ON "ScoringBatchItem"("batchId", "jobId");
CREATE UNIQUE INDEX "ScoringBatchItem_importedScoreEventId_key" ON "ScoringBatchItem"("importedScoreEventId");
CREATE UNIQUE INDEX "ScoringBatchItem_one_active_lease_per_job" ON "ScoringBatchItem"("jobId") WHERE "status" = 'leased';
CREATE INDEX "ScoringBatchItem_jobId_status_idx" ON "ScoringBatchItem"("jobId", "status");
CREATE INDEX "ScoringBatchItem_sourceAimEventId_idx" ON "ScoringBatchItem"("sourceAimEventId");
CREATE INDEX "ScoringBatchItem_cleanedArtifactId_idx" ON "ScoringBatchItem"("cleanedArtifactId");

CREATE INDEX "JobScoringArtifact_contentHash_idx" ON "JobScoringArtifact"("contentHash");
CREATE UNIQUE INDEX "JobScoringArtifact_producedByBatchItemId_key" ON "JobScoringArtifact"("producedByBatchItemId");
CREATE INDEX "JobScoringArtifact_jobId_createdAt_idx" ON "JobScoringArtifact"("jobId", "createdAt");
CREATE INDEX "JobScoringArtifact_jobId_staleAt_idx" ON "JobScoringArtifact"("jobId", "staleAt");

CREATE UNIQUE INDEX "JobScoreEvent_batchItemId_key" ON "JobScoreEvent"("batchItemId");
CREATE INDEX "JobScoreEvent_jobId_evaluationType_createdAt_idx" ON "JobScoreEvent"("jobId", "evaluationType", "createdAt");
CREATE INDEX "JobScoreEvent_sourceAimEventId_idx" ON "JobScoreEvent"("sourceAimEventId");
CREATE INDEX "JobScoreEvent_cleanedJdArtifactId_idx" ON "JobScoreEvent"("cleanedJdArtifactId");

ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ScoringBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_sourceAimEventId_fkey" FOREIGN KEY ("sourceAimEventId") REFERENCES "JobScoreEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_cleanedArtifactId_fkey" FOREIGN KEY ("cleanedArtifactId") REFERENCES "JobScoringArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoringBatchItem" ADD CONSTRAINT "ScoringBatchItem_importedScoreEventId_fkey" FOREIGN KEY ("importedScoreEventId") REFERENCES "JobScoreEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobScoringArtifact" ADD CONSTRAINT "JobScoringArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobScoringArtifact" ADD CONSTRAINT "JobScoringArtifact_producedByBatchItemId_fkey" FOREIGN KEY ("producedByBatchItemId") REFERENCES "ScoringBatchItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historical score-event rows may outlive jobs deleted before restrictive
-- provenance was introduced. Preserve those rows, while enforcing the
-- relationship for every new insert/update from this cutover forward.
ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_batchItemId_fkey" FOREIGN KEY ("batchItemId") REFERENCES "ScoringBatchItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_sourceAimEventId_fkey" FOREIGN KEY ("sourceAimEventId") REFERENCES "JobScoreEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobScoreEvent" ADD CONSTRAINT "JobScoreEvent_cleanedJdArtifactId_fkey" FOREIGN KEY ("cleanedJdArtifactId") REFERENCES "JobScoringArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
