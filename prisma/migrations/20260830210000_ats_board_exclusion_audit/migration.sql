-- Expand-only. Board exclusion already worked through AtsCompany.status; these
-- columns only record why a board left the rotation and when, so a permanent
-- exclusion stays reviewable and can be undone selectively rather than as an
-- undifferentiated block. No existing row changes meaning: pre-existing
-- excluded boards simply carry a null reason.
ALTER TABLE "AtsCompany"
  ADD COLUMN "excludedReason" TEXT,
  ADD COLUMN "excludedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AtsCompany_excludedAt_idx" ON "AtsCompany" ("excludedAt");
