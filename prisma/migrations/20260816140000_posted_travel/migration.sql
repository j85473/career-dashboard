-- The travel figure a posting states outright, kept as text so it can hold
-- "up to 50%", "25-30%", or "none stated" without pretending to be a score.
-- Job.travelScore is a separate, now-unwritten numeric column from the retired
-- pre-v2 design; this deliberately does not reuse it.
ALTER TABLE "Job" ADD COLUMN "postedTravel" TEXT;
