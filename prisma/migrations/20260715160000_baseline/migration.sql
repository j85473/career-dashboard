-- Idempotent baseline for installations that predate Prisma migration history.
-- Existing databases created with `prisma db push` keep their data; a fresh
-- database receives the original schema before additive hardening migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS "Job" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "url" TEXT,
    "source" TEXT,
    "sourceId" TEXT,
    "canonicalUrl" TEXT,
    "fingerprint" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_af',
    "scoringStatus" TEXT NOT NULL DEFAULT 'queued',
    "scoreAttempts" INTEGER NOT NULL DEFAULT 0,
    "scoreError" TEXT,
    "fitScore" INTEGER,
    "fitCategory" TEXT NOT NULL DEFAULT 'unscored',
    "fitRationale" TEXT,
    "tailoringAdvice" TEXT,
    "recommendedResume" TEXT,
    "tailoringStaged" BOOLEAN NOT NULL DEFAULT false,
    "passReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "manualAts" TEXT,
    "batchJobId" TEXT,
    "experienceStatus" TEXT NOT NULL DEFAULT 'queued',
    "reqFitRationale" TEXT,
    "reqFitScore" INTEGER,
    "afBatchId" TEXT,
    "contextBatched" BOOLEAN NOT NULL DEFAULT false,
    "jdBatchId" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "travelScore" INTEGER,
    "aimFitScore" INTEGER,
    "contextPacket" TEXT,
    "submittedResume" TEXT,
    "cooldownUntil" TIMESTAMP(3),
    "luckyAimFitScore" INTEGER,
    "luckyFitCategory" TEXT NOT NULL DEFAULT 'unscored',
    "luckyFitScore" INTEGER,
    "luckyPassReason" TEXT,
    "luckyScoreAttempts" INTEGER NOT NULL DEFAULT 0,
    "luckyScoreError" TEXT,
    "luckyStatus" TEXT NOT NULL DEFAULT 'none',

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobSourceObservation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "url" TEXT,

    CONSTRAINT "JobSourceObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobSourceObservation_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "UserPreference" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UsageTracking" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "UsageTracking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UsedArticle" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedArticle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LinkedInDraft" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "postText" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedInDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AtsCompany" (
    "slug" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "nextCheckDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobsFound" INTEGER NOT NULL DEFAULT 0,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "AtsCompany_pkey" PRIMARY KEY ("slug", "platform")
);

CREATE TABLE IF NOT EXISTS "ContextProfile" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "rulesText" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "batchJobId" TEXT,
    "linkedinBatchId" TEXT,

    CONSTRAINT "ContextProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WildcardProfile" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "profileText" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WildcardProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UsedWildcardQuery" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedWildcardQuery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OutreachTarget" (
    "id" TEXT NOT NULL,
    "publicIdentifier" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "headline" TEXT,
    "company" TEXT,
    "linkedinUrl" TEXT NOT NULL,
    "about" TEXT,
    "locationText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "generatedPitch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT,
    "generatedNote" TEXT,

    CONSTRAINT "OutreachTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Job_status_idx" ON "Job"("status");
CREATE INDEX IF NOT EXISTS "Job_scoringStatus_idx" ON "Job"("scoringStatus");
CREATE INDEX IF NOT EXISTS "Job_luckyStatus_idx" ON "Job"("luckyStatus");
CREATE INDEX IF NOT EXISTS "Job_fingerprint_idx" ON "Job"("fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "JobSourceObservation_source_sourceId_key"
    ON "JobSourceObservation"("source", "sourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "UsageTracking_date_key" ON "UsageTracking"("date");
CREATE UNIQUE INDEX IF NOT EXISTS "UsedArticle_url_key" ON "UsedArticle"("url");
CREATE UNIQUE INDEX IF NOT EXISTS "UsedWildcardQuery_query_key" ON "UsedWildcardQuery"("query");
CREATE UNIQUE INDEX IF NOT EXISTS "OutreachTarget_linkedinUrl_key" ON "OutreachTarget"("linkedinUrl");

COMMIT;
