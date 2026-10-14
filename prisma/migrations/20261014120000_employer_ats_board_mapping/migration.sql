-- Persist only verified employer-to-board associations. The resolver may
-- learn several aliases for one employer and an employer may use more than one
-- ATS board, so the identity and board together form the key.
CREATE TABLE "EmployerAtsBoard" (
    "employerKey" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "officialWebsite" TEXT,
    "evidenceUrl" TEXT NOT NULL,
    "discoverySource" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployerAtsBoard_pkey" PRIMARY KEY ("employerKey", "slug", "platform")
);

CREATE INDEX "EmployerAtsBoard_slug_platform_idx" ON "EmployerAtsBoard"("slug", "platform");
CREATE INDEX "EmployerAtsBoard_employerKey_idx" ON "EmployerAtsBoard"("employerKey");

ALTER TABLE "EmployerAtsBoard"
ADD CONSTRAINT "EmployerAtsBoard_slug_platform_fkey"
FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform")
ON DELETE RESTRICT ON UPDATE CASCADE;
