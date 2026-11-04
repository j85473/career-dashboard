-- Dormant until the operator retires the old API worker. No existing work,
-- board ownership, schedule, score, or runtime setting is changed on install.
ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD COLUMN "legacyAcquisitionRetiredAt" TIMESTAMP(3),
  ADD COLUMN "legacyAcquisitionRetirementReleaseId" TEXT,
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_legacy_retirement_check" CHECK (
    ("legacyAcquisitionRetiredAt" IS NULL AND "legacyAcquisitionRetirementReleaseId" IS NULL)
    OR ("legacyAcquisitionRetiredAt" IS NOT NULL
      AND "legacyAcquisitionRetirementReleaseId" IS NOT NULL
      AND "legacyAcquisitionRetirementReleaseId" ~ '^[a-f0-9]{40}$'
      AND "v2AuthorityActivatedAt" IS NOT NULL AND "activatedLedgerVersion" IS NOT NULL AND "activatedLedgerVersion" >= 2
      AND "minimumWriterVersion" >= 3 AND "compatibilityWriterVersion" >= 3)
  );

-- Mirrors NON_API_ATS_PLATFORMS; the contract test checks this exact boundary.
-- These collectors do not use the API worker being retired, even when they
-- transport their own public-board requests over HTTP.
CREATE FUNCTION ats_uses_api_acquisition(platform TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  SELECT platform NOT IN ('gusto', 'adp', 'avature', 'brassring', 'dzconnex',
    'icims', 'paycor', 'paycom', 'paylocity', 'phenom', 'sagehr', 'talemetry',
    'taleo', 'jobvite', 'freshteam', 'cats');
$$;

CREATE FUNCTION ats_legacy_worker_retirement_blockers() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT jsonb_build_object(
    'unfinishedBatches', (SELECT count(*) FROM "AtsIngestionBatch" b
      WHERE ats_uses_api_acquisition(b.platform) AND b."writerMode" = 'legacy'
        AND (b.status IN ('fetching', 'partial', 'synchronized', 'queued', 'processing')
          OR (b."jobCount" > b."processingOffset" AND b.status NOT IN ('excluded', 'operator_abandoned'))
          OR b."leaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
          OR b."acquisitionLeaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC')),
    'runningAttempts', (SELECT count(*) FROM "AtsBoardCheckAttempt" a
      WHERE ats_uses_api_acquisition(a.platform) AND a.outcome = 'running'),
    'convertingBatches', (SELECT count(*) FROM "AtsIngestionBatch" b
      WHERE ats_uses_api_acquisition(b.platform) AND b."writerMode" = 'converting'),
    'convertingBoards', (SELECT count(*) FROM "AtsCompany" b
      WHERE ats_uses_api_acquisition(b.platform) AND b."acquisitionEngine" = 'converting')
  );
$$;

CREATE FUNCTION guard_ats_legacy_worker_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE blockers JSONB;
BEGIN
  IF OLD."legacyAcquisitionRetiredAt" IS NOT NULL THEN
    IF NEW."legacyAcquisitionRetiredAt" IS DISTINCT FROM OLD."legacyAcquisitionRetiredAt"
      OR NEW."legacyAcquisitionRetirementReleaseId" IS DISTINCT FROM OLD."legacyAcquisitionRetirementReleaseId" THEN
      RAISE EXCEPTION 'Legacy API worker retirement cannot be undone by a rollback.' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."legacyAcquisitionRetiredAt" IS NULL THEN RETURN NEW; END IF;
  -- The gate row update conflicts with the shared row lock taken before every
  -- legacy admission below. An older binary cannot race this zero-work check.
  blockers := ats_legacy_worker_retirement_blockers();
  IF EXISTS (SELECT 1 FROM jsonb_each_text(blockers) b WHERE b.value::bigint <> 0) THEN
    RAISE EXCEPTION 'Legacy API work must drain before retirement: %', blockers USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AtsAcquisitionWorkerSlot" s
      WHERE s."leaseToken" IS NOT NULL AND s."leaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        AND s."workerKind" = 'mac-continuation' AND s."releaseId" = NEW."legacyAcquisitionRetirementReleaseId")
    OR EXISTS (SELECT 1 FROM "AtsAcquisitionWorkerSlot" s
      WHERE s."leaseToken" IS NOT NULL AND s."leaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        AND s."releaseId" IS DISTINCT FROM NEW."legacyAcquisitionRetirementReleaseId") THEN
    RAISE EXCEPTION 'Retirement requires a healthy v2 worker on the selected release and no mixed-release leases.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_ats_legacy_worker_retirement
BEFORE UPDATE OF "legacyAcquisitionRetiredAt", "legacyAcquisitionRetirementReleaseId" ON "AtsAcquisitionRuntimeGate"
FOR EACH ROW EXECUTE FUNCTION guard_ats_legacy_worker_retirement();

CREATE FUNCTION guard_retired_ats_legacy_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE retired_at TIMESTAMP(3);
BEGIN
  IF NOT ats_uses_api_acquisition(NEW.platform) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'AtsIngestionBatch' THEN
    IF NEW."writerMode" <> 'legacy' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.status NOT IN ('fetching', 'partial', 'synchronized', 'queued', 'processing')
      AND NEW."leaseToken" IS NULL AND NEW."acquisitionClaimToken" IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.outcome <> 'running' THEN RETURN NEW;
  END IF;
  SELECT "legacyAcquisitionRetiredAt" INTO retired_at FROM "AtsAcquisitionRuntimeGate"
    WHERE id = 'global' FOR SHARE;
  IF retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'The legacy API acquisition worker is retired; new work belongs to v2.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_retired_ats_legacy_batch_admission
BEFORE INSERT OR UPDATE OF "writerMode", status, "leaseToken", "acquisitionClaimToken" ON "AtsIngestionBatch"
FOR EACH ROW EXECUTE FUNCTION guard_retired_ats_legacy_admission();
CREATE TRIGGER guard_retired_ats_legacy_attempt_admission
BEFORE INSERT OR UPDATE OF outcome ON "AtsBoardCheckAttempt"
FOR EACH ROW EXECUTE FUNCTION guard_retired_ats_legacy_admission();

CREATE FUNCTION route_boards_after_ats_legacy_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE retired_at TIMESTAMP(3);
BEGIN
  IF NOT ats_uses_api_acquisition(NEW.platform) OR NEW."acquisitionEngine" <> 'legacy' THEN RETURN NEW; END IF;
  SELECT "legacyAcquisitionRetiredAt" INTO retired_at FROM "AtsAcquisitionRuntimeGate"
    WHERE id = 'global' FOR SHARE;
  IF retired_at IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN NEW."acquisitionEngine" := 'v2';
    ELSIF OLD."acquisitionEngine" <> 'legacy' THEN
      RAISE EXCEPTION 'API board ownership cannot return to the retired legacy worker.' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER route_boards_after_ats_legacy_retirement
BEFORE INSERT OR UPDATE OF "acquisitionEngine" ON "AtsCompany"
FOR EACH ROW EXECUTE FUNCTION route_boards_after_ats_legacy_retirement();
