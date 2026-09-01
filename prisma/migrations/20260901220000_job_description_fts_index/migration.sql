-- Restore searching job descriptions, with an index shape that can actually
-- serve it. Already created on the production database by hand, so this is a
-- no-op there; IF NOT EXISTS keeps it correct on a database that lacks it.
--
-- The previous attempt was a pg_trgm GIN index on the raw column. That could
-- never work: descriptions average ~2.1KB and live in TOAST, so a trigram hit
-- is only a candidate that must be rechecked against the de-TOASTed text.
-- Measured on production, `title ILIKE '%channel partner%'` returned 141 rows
-- in 0.67s while the same predicate on `description` had not finished after
-- 12s, and the index cost 2838MB for the privilege.
--
-- A GIN index over to_tsvector is exact for these queries, so the heap recheck
-- never re-evaluates the expression and the TOAST chunks are never read.
-- Prisma cannot express a functional index, so this migration owns it; the
-- matching query in src/app/api/jobs/search/route.ts must use this exact
-- expression or the planner cannot use the index.
--
-- Creating an index reads no row and changes no row: no job loses a score.
CREATE INDEX IF NOT EXISTS "Job_description_fts_idx"
  ON "Job" USING gin (to_tsvector('english', description));
