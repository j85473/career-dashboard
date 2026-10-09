-- Additive rollout control. Never rewrite Jobs, scores, existing batches or cursors.
ALTER TABLE "AtsCompany"
  ADD COLUMN "firstCollectionState" TEXT NOT NULL DEFAULT 'established',
  ADD COLUMN "firstCollectionBatchId" TEXT,
  ADD COLUMN "firstCollectionAdmittedAt" TIMESTAMP(3),
  ADD COLUMN "firstCollectionCompletedAt" TIMESTAMP(3),
  ADD COLUMN "firstCollectionHoldReason" TEXT;
CREATE INDEX "AtsCompany_platform_firstCollectionState_idx" ON "AtsCompany" (platform, "firstCollectionState");
CREATE INDEX "AtsCompany_firstCollectionAdmittedAt_idx" ON "AtsCompany" ("firstCollectionAdmittedAt");

CREATE TABLE "AtsFirstCollectionPolicy" (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'held',
  "dailyBoardLimit" INTEGER NOT NULL DEFAULT 5 CHECK ("dailyBoardLimit" BETWEEN 1 AND 100),
  "maxUnfinished" INTEGER NOT NULL DEFAULT 1 CHECK ("maxUnfinished" BETWEEN 1 AND 8),
  "maxCatalogueJobs" INTEGER NOT NULL DEFAULT 250 CHECK ("maxCatalogueJobs" BETWEEN 1 AND 10000),
  "maxResponseBytes" INTEGER NOT NULL DEFAULT 5242880 CHECK ("maxResponseBytes" BETWEEN 1024 AND 52428800),
  "pilotBoards" JSONB NOT NULL DEFAULT '[]', "healthySince" TIMESTAMP(3),
  "healthObservedAt" TIMESTAMP(3), "lastStagedItems" INTEGER, "lastPersistenceJobs" INTEGER,
  "validationLeaseToken" TEXT, "validationLeaseExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (mode IN ('held','pilot','ramp'))
);
INSERT INTO "AtsFirstCollectionPolicy" (id) VALUES ('new-providers');
CREATE TABLE "AtsFirstCollectionCandidate" (
  slug TEXT NOT NULL, platform TEXT NOT NULL, "sourceUrl" TEXT, "discoveryRunId" TEXT,
  state TEXT NOT NULL DEFAULT 'discovered', "estimatedJobs" INTEGER, "lastError" TEXT,
  "validatedAt" TIMESTAMP(3), "nextValidationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastValidationStartedAt" TIMESTAMP(3),
  "lastFeedRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (slug, platform)
);
CREATE INDEX "AtsFirstCollectionCandidate_state_nextValidationAt_createdAt_idx"
  ON "AtsFirstCollectionCandidate" (state, "nextValidationAt", "createdAt");

-- An untouched Zoho/new-provider row can wait; started work is grandfathered.
UPDATE "AtsCompany" board SET "firstCollectionState" = 'waiting'
WHERE platform IN ('zohorecruit','gem','jobscore','jazzhr','manatal','clearcompany','hirehive')
  AND NOT EXISTS (SELECT 1 FROM "AtsIngestionBatch" b WHERE b.slug=board.slug AND b.platform=board.platform);

CREATE FUNCTION ats_first_collection_board_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.platform IN ('zohorecruit','gem','jobscore','jazzhr','manatal','clearcompany','hirehive') THEN
    NEW."firstCollectionState" := 'waiting';
    NEW."firstCollectionBatchId" := NULL;
    NEW."firstCollectionAdmittedAt" := NULL;
    NEW."firstCollectionCompletedAt" := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ats_first_collection_board_guard BEFORE INSERT ON "AtsCompany"
FOR EACH ROW EXECUTE FUNCTION ats_first_collection_board_guard();

-- The batch fence also protects against old workers and raw-SQL admission.
-- Application reservations carry the exact batch ID inside the same transaction.
CREATE FUNCTION ats_first_collection_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE board_state TEXT; reserved_batch TEXT;
BEGIN
  IF NEW.platform NOT IN ('zohorecruit','gem','jobscore','jazzhr','manatal','clearcompany','hirehive') THEN RETURN NEW; END IF;
  SELECT "firstCollectionState", "firstCollectionBatchId" INTO board_state, reserved_batch
    FROM "AtsCompany" WHERE slug=NEW.slug AND platform=NEW.platform FOR SHARE;
  IF board_state = 'established' THEN RETURN NEW; END IF;
  IF board_state = 'admitted' AND reserved_batch = NEW.id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ATS first collection requires a durable admission reservation' USING ERRCODE='23514';
END $$;
CREATE TRIGGER ats_first_collection_batch_guard BEFORE INSERT ON "AtsIngestionBatch"
FOR EACH ROW EXECUTE FUNCTION ats_first_collection_batch_guard();
