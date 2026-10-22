ALTER TABLE "Job" ADD COLUMN "userCanonicalUrl" TEXT;
ALTER TABLE "Job" ADD COLUMN "userCanonicalUrlUpdatedAt" TIMESTAMP(3);

-- Enforce this at the write boundary so crawlers, repairs, raw SQL and merges
-- cannot replace a deliberate user link. Existing rows are not backfilled:
-- historical source URLs alone are not proof of a user choice.
CREATE FUNCTION preserve_user_canonical_job_url() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."userCanonicalUrl" IS NOT NULL
     AND NEW."userCanonicalUrl" IS NULL THEN
    NEW."userCanonicalUrl" := OLD."userCanonicalUrl";
    NEW."userCanonicalUrlUpdatedAt" := OLD."userCanonicalUrlUpdatedAt";
  END IF;
  IF NEW."userCanonicalUrl" IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND NEW."userCanonicalUrl" IS NOT DISTINCT FROM OLD."userCanonicalUrl"
       AND NEW."userCanonicalUrlUpdatedAt" IS NOT DISTINCT FROM OLD."userCanonicalUrlUpdatedAt"
       AND (NEW.url IS DISTINCT FROM OLD.url OR NEW."canonicalUrl" IS DISTINCT FROM OLD."canonicalUrl")
       AND NOT (NEW.status = 'dismissed' AND NEW."passReason" LIKE 'Consolidated after URL edit into job %') THEN
      NEW."postingIdentity" := OLD."postingIdentity";
    END IF;
    NEW.url := NEW."userCanonicalUrl";
    NEW."canonicalUrl" := NEW."userCanonicalUrl";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Job_preserve_user_canonical_url"
BEFORE INSERT OR UPDATE ON "Job"
FOR EACH ROW EXECUTE FUNCTION preserve_user_canonical_job_url();
