-- A manual pause used to be a boolean with no clock, so a forgotten Stop kept
-- the scheduler off indefinitely with no error anywhere. `pausedUntil` records
-- when the pause lapses; NULL alongside `schedulePaused = true` still means an
-- explicitly indefinite pause.
ALTER TABLE "PipelineState" ADD COLUMN "pausedUntil" TIMESTAMP(3);
