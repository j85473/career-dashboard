-- Ingestion deduplication looks up `canonicalUrl` case-insensitively. Prisma
-- renders that as ILIKE, which "Job_canonicalUrl_idx" cannot serve, so the
-- lookup degraded into a parallel sequential scan of the whole 45-day window:
-- 3.1s and ~3.1GB of buffers for every incoming job. The deduper now compares
-- lower("canonicalUrl") directly, which this expression index resolves.
--
-- Prisma cannot express an expression index in schema.prisma, so this
-- migration owns it. See the note on the Job model.
CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_lower_idx" ON "Job" (lower("canonicalUrl"));

-- Statistics for an expression index only exist once ANALYZE has run. Without
-- them the planner estimates thousands of matches for an equality on
-- lower("canonicalUrl"), decides the ORDER BY/LIMIT is better served by walking
-- "Job_createdAt_idx" backwards, and never touches the new index at all. That
-- plan was measured at 9.7s — worse than the 3.2s scan this migration exists to
-- remove. Collect them here so the index is usable the moment it is created.
ANALYZE "Job";
