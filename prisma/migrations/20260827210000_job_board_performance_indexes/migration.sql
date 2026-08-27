-- The live plans previously performed parallel full-table scans for an empty
-- Tailoring board and for observation lookup by Job relation.
CREATE INDEX IF NOT EXISTS "Job_tailoringStaged_idx" ON "Job"("tailoringStaged");
CREATE INDEX IF NOT EXISTS "Job_status_updatedAt_idx" ON "Job"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "JobSourceObservation_jobId_idx" ON "JobSourceObservation"("jobId");
