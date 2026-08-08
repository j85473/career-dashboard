-- Forward-only activity history for stats that must be based on when an event
-- happened, not on a job's current mutable state.
BEGIN;

CREATE TABLE IF NOT EXISTS "JobStatusHistory" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "JobStatusHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobStatusHistory_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "JobStatusHistory_jobId_createdAt_idx"
ON "JobStatusHistory"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobStatusHistory_status_createdAt_idx"
ON "JobStatusHistory"("status", "createdAt");

CREATE TABLE "JobScoringStatusHistory" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "scoringStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "JobScoringStatusHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobScoringStatusHistory_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "JobScoringStatusHistory_jobId_createdAt_idx"
ON "JobScoringStatusHistory"("jobId", "createdAt");
CREATE INDEX "JobScoringStatusHistory_scoringStatus_createdAt_idx"
ON "JobScoringStatusHistory"("scoringStatus", "createdAt");

CREATE TABLE "StatsTrackingEpoch" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "StatsTrackingEpoch_pkey" PRIMARY KEY ("id")
);

INSERT INTO "StatsTrackingEpoch" ("id", "startedAt")
VALUES ('daily-activity-v2', CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

CREATE FUNCTION record_job_activity_history() RETURNS trigger
LANGUAGE plpgsql
AS $activity_history$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "JobStatusHistory" ("id", "jobId", "status", "createdAt")
        VALUES (
            md5(NEW.id || ':status:' || clock_timestamp()::text || ':' || random()::text),
            NEW.id,
            NEW.status,
            CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        );
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO "JobStatusHistory" ("id", "jobId", "status", "createdAt")
        VALUES (
            md5(NEW.id || ':status:' || clock_timestamp()::text || ':' || random()::text),
            NEW.id,
            NEW.status,
            CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        );
    END IF;

    -- An initial 'skipped' value is an ingestion-time title/location filter,
    -- not a local-scoring decision. Only transitions are local scoring events.
    IF TG_OP = 'UPDATE' THEN
        IF OLD."scoringStatus" IS DISTINCT FROM NEW."scoringStatus" THEN
            INSERT INTO "JobScoringStatusHistory" ("id", "jobId", "scoringStatus", "createdAt")
            VALUES (
                md5(NEW.id || ':scoring:' || clock_timestamp()::text || ':' || random()::text),
                NEW.id,
                NEW."scoringStatus",
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$activity_history$;

CREATE TRIGGER record_job_activity_history_trigger
AFTER INSERT OR UPDATE OF status, "scoringStatus" ON "Job"
FOR EACH ROW EXECUTE FUNCTION record_job_activity_history();

COMMIT;
