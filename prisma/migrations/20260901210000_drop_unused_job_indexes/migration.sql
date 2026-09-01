-- Drop two indexes on "Job" that no query can use. Already applied to the
-- production database by hand with DROP INDEX CONCURRENTLY, so both statements
-- are no-ops there; IF EXISTS keeps them safe on any database that never had
-- them. No table data is read or changed, and no row loses a score.
--
-- "Job_description_idx" (2838MB, a quarter of the database) was a pg_trgm GIN
-- index built for a description search that was removed for being too slow.
-- The index could not have saved it: descriptions average ~2.1KB and live in
-- TOAST, so a trigram hit is only a candidate that must then be rechecked
-- against the de-TOASTed text. Measured on production, `title ILIKE
-- '%channel partner%'` returned 141 rows in 0.67s while the same predicate on
-- `description` had not finished after 12s. Nothing in src/ queries
-- `description` with contains/ILIKE; the two callers are one-off repair
-- scripts, and scoringExport only tests `description IS NOT NULL`, which no
-- trigram index can serve.
--
-- "Job_fingerprint_idx" (32MB) is a non-unique btree on the same single column
-- as the unique "Job_fingerprint_key". The planner can never prefer it.
DROP INDEX IF EXISTS "Job_description_idx";
DROP INDEX IF EXISTS "Job_fingerprint_idx";
