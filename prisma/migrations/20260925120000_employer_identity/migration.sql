-- One employer, one name. `Job.employer` is derived from `Job.company` (which
-- stays exactly what the source wrote, because it is a scoring input) and is
-- filled by the pipeline's employer pass; nothing here rewrites a Job.
ALTER TABLE "Job" ADD COLUMN "employer" TEXT;

-- Only resolved rows are indexed. The 1.8M triaged and archived rows that are
-- never resolved stay out of the index, and building it on an all-null column
-- is one quick scan.
CREATE INDEX IF NOT EXISTS "Job_employer_idx" ON "Job" ("employer") WHERE "employer" IS NOT NULL;

-- Rules Joseph wrote stay `manual`; the learner owns only `learned` rows.
ALTER TABLE "CompanyNameRule" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "CompanyNameRule" ADD COLUMN "evidence" JSONB;
CREATE INDEX "CompanyNameRule_origin_idx" ON "CompanyNameRule"("origin");
