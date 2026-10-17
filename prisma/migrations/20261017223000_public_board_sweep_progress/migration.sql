-- Additive progress only. No existing jobs, scores, boards or API receipts are rewritten.
CREATE TABLE "AtsBrowserSweep" (
 "slug" TEXT NOT NULL,
 "platform" TEXT NOT NULL,
 "cursor" JSONB NOT NULL DEFAULT '{}',
 "status" TEXT NOT NULL DEFAULT 'pending',
 "lastError" TEXT,
 "lastCompletedAt" TIMESTAMP(3),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AtsBrowserSweep_pkey" PRIMARY KEY ("slug", "platform")
);
CREATE INDEX "AtsBrowserSweep_platform_status_idx" ON "AtsBrowserSweep"("platform", "status");
