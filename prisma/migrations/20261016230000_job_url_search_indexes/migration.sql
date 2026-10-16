-- URL substring search must not scan every saved job and retained source link.
-- These indexes change no job data or score authority. Deployment quiesces
-- writers and takes a recovery backup before applying this migration.
CREATE INDEX IF NOT EXISTS "Job_url_trgm_idx"
  ON "Job" USING gin (url gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_trgm_idx"
  ON "Job" USING gin ("canonicalUrl" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "JobSourceObservation_url_trgm_idx"
  ON "JobSourceObservation" USING gin (url gin_trgm_ops);
