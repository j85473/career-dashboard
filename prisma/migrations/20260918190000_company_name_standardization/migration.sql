-- Company-name rules are prospective authority. Creating or changing one does
-- not rewrite existing jobs, scores, lifecycle state, or source observations.
CREATE TABLE "CompanyNameRule" (
    "matchType" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "standardName" TEXT NOT NULL,
    "provenanceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyNameRule_pkey" PRIMARY KEY ("matchType", "matchKey")
);

CREATE INDEX "CompanyNameRule_standardName_idx" ON "CompanyNameRule"("standardName");
