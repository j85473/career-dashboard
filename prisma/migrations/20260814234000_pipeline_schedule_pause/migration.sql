-- A manual stop is durable across cron ticks and service restarts. Deployment
-- quiescence explicitly leaves this false so activation resumes automation.
ALTER TABLE "PipelineState"
ADD COLUMN "schedulePaused" BOOLEAN NOT NULL DEFAULT false;
