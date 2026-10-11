-- Expand policy options only. Existing jobs, scores, work and operator mode stay intact.
ALTER TABLE "AtsFirstCollectionPolicy"
  DROP CONSTRAINT "AtsFirstCollectionPolicy_mode_check",
  DROP CONSTRAINT "AtsFirstCollectionPolicy_dailyBoardLimit_check",
  DROP CONSTRAINT "AtsFirstCollectionPolicy_maxUnfinished_check",
  ADD CONSTRAINT "AtsFirstCollectionPolicy_mode_check" CHECK (mode IN ('held','pilot','ramp','capacity')),
  ADD CONSTRAINT "AtsFirstCollectionPolicy_dailyBoardLimit_check" CHECK (
    "dailyBoardLimit" BETWEEN 1 AND 100 OR mode IN ('capacity','held') AND "dailyBoardLimit" = 0),
  ADD CONSTRAINT "AtsFirstCollectionPolicy_maxUnfinished_check" CHECK ("maxUnfinished" BETWEEN 1 AND 32);
