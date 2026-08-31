-- Whole-queue manual-scoring run bundles with independently recoverable child
-- batches. Historical batches and accepted score events remain unchanged.

CREATE TABLE "ScoringRun" (
    "id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'exported',
    "schemaVersion" TEXT NOT NULL,
    "batchSize" INTEGER NOT NULL,
    "jobCount" INTEGER NOT NULL,
    "batchCount" INTEGER NOT NULL,
    "exportHash" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "exportJson" TEXT NOT NULL,
    "exportByteLength" INTEGER NOT NULL,
    "acceptedResultHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    CONSTRAINT "ScoringRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScoringRun_stage_check" CHECK ("stage" IN ('aim', 'experience')),
    CONSTRAINT "ScoringRun_status_check" CHECK ("status" IN ('exported', 'completed', 'released')),
    CONSTRAINT "ScoringRun_schema_check" CHECK ("schemaVersion" = 'career-dashboard-scoring-run-export-v1'),
    CONSTRAINT "ScoringRun_size_check" CHECK (
      "batchSize" = 40
      AND "jobCount" BETWEEN 1 AND 2000
      AND "batchCount" = (("jobCount" + 39) / 40)
    ),
    CONSTRAINT "ScoringRun_export_length_check" CHECK ("exportByteLength" > 0 AND "exportByteLength" <= 67108864),
    CONSTRAINT "ScoringRun_completion_check" CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL)),
    CONSTRAINT "ScoringRun_release_check" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL))
);

ALTER TABLE "ScoringBatch"
  ADD COLUMN "runId" TEXT,
  ADD COLUMN "runOrdinal" INTEGER,
  ADD CONSTRAINT "ScoringBatch_run_binding_check" CHECK (
    ("runId" IS NULL AND "runOrdinal" IS NULL)
    OR ("runId" IS NOT NULL AND "runOrdinal" IS NOT NULL AND "runOrdinal" >= 0)
  );

-- One historical/direct batch may remain active only when it is not attached
-- to a run. New run children are governed by ScoringRun's stage-level lease.
CREATE UNIQUE INDEX "ScoringBatch_one_unbundled_nonterminal_per_stage"
  ON "ScoringBatch"("stage")
  WHERE "status" IN ('exported', 'superseded') AND "runId" IS NULL;
CREATE UNIQUE INDEX "ScoringRun_one_nonterminal_per_stage"
  ON "ScoringRun"("stage")
  WHERE "status" = 'exported';

-- The narrower replacement is established before the obsolete index is
-- removed, so direct-batch exclusion never has an uncovered interval.
DROP INDEX "ScoringBatch_one_nonterminal_per_stage";

CREATE UNIQUE INDEX "ScoringRun_exportHash_key" ON "ScoringRun"("exportHash");
CREATE UNIQUE INDEX "ScoringRun_manifestHash_key" ON "ScoringRun"("manifestHash");
CREATE INDEX "ScoringRun_stage_status_createdAt_idx" ON "ScoringRun"("stage", "status", "createdAt");
CREATE INDEX "ScoringRun_expiresAt_idx" ON "ScoringRun"("expiresAt");
CREATE UNIQUE INDEX "ScoringBatch_runId_runOrdinal_key" ON "ScoringBatch"("runId", "runOrdinal");
CREATE INDEX "ScoringBatch_runId_status_idx" ON "ScoringBatch"("runId", "status");

ALTER TABLE "ScoringBatch" ADD CONSTRAINT "ScoringBatch_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ScoringRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
