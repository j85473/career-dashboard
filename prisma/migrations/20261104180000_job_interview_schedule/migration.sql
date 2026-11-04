CREATE TABLE "JobInterview" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobInterview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobInterview_jobId_scheduledAt_idx" ON "JobInterview"("jobId", "scheduledAt");
ALTER TABLE "JobInterview" ADD CONSTRAINT "JobInterview_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
