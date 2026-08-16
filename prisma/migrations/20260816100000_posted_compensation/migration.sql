-- A distinct field keeps an employer-posted base range separate from the
-- legacy score projection, which may contain total-compensation context.
ALTER TABLE "Job" ADD COLUMN "postedCompensation" TEXT;
