-- Every ATS board is assigned one weekday and is swept on that day.
--
-- The previous scheme rescheduled each board a fixed interval after its last
-- successful check. That is a rolling queue, not a rotation: the catalog
-- inherited whatever uneven distribution it already had, every board read as
-- overdue at once, and there was no way to state or measure "this board runs on
-- Tuesday".
--
-- 0 = Sunday through 6 = Saturday, matching JavaScript's getDay().
--
-- The column lands with every row on day 0 and is assigned by
-- `npm run ats:assign-rotation-days`. The spread is deliberately NOT done in
-- SQL: `assignedRotationDay` in src/lib/atsRotation.ts is the single definition
-- of which board belongs to which day, and a second implementation here could
-- disagree with it and silently move boards between cohorts.
--
-- Until that backfill runs the coverage SLO reports the imbalance outright, and
-- the sweep degrades gracefully — an empty cohort for the day simply hands the
-- whole budget to the carryover path, which is the previous behaviour.
ALTER TABLE "AtsCompany" ADD COLUMN "checkDay" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "AtsCompany_status_checkDay_idx" ON "AtsCompany"("status", "checkDay");
