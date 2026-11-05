-- Only disposable acquisition payloads are eligible. No job/scoring table is changed.
ALTER TABLE "AtsIngestionBatch"
 ADD COLUMN "rawDisposedAt" TIMESTAMP(3),
 ADD COLUMN "rawDisposalReceipt" JSONB,
 ADD COLUMN "rawArchiveFilesDeletedAt" TIMESTAMP(3);

CREATE FUNCTION ats_completed_disposal_eligible(batch_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM "AtsIngestionBatch" b WHERE b.id=batch_id
   AND b."writerMode"='v2' AND b.status='processed' AND b."acquisitionPhase"='synchronized'
   AND b."operatorResetAt" IS NULL AND b."processingErrorCount"=0
   AND b."processedAt" < (now() AT TIME ZONE 'UTC')-interval '1 day'
   AND (b."leaseToken" IS NULL OR b."leaseExpiresAt" <= now() AT TIME ZONE 'UTC')
   AND (b."acquisitionClaimToken" IS NULL OR b."acquisitionLeaseExpiresAt" <= now() AT TIME ZONE 'UTC')
   AND EXISTS (SELECT 1 FROM "AtsIngestionBatch" newer
     WHERE newer.slug=b.slug AND newer.platform=b.platform AND newer.status='processed'
       AND newer."writerMode"='v2' AND newer."operatorResetAt" IS NULL
       AND newer."acquisitionPhase"='synchronized' AND newer."processingErrorCount"=0
       AND (newer."createdAt",newer.id)>(b."createdAt",b.id))
   AND NOT EXISTS (SELECT 1 FROM "AtsIngestionSegment" s WHERE s."batchId"=b.id
     AND (s.status<>'processed' OR s."processingErrorCount"<>0 OR s."processingOffset"<>s."itemCount"
       OR (s."leaseToken" IS NOT NULL AND (s."leaseExpiresAt" IS NULL OR s."leaseExpiresAt">now() AT TIME ZONE 'UTC'))))
 );
$$;

CREATE FUNCTION guard_ats_raw_disposal() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW."rawDisposedAt" IS NOT DISTINCT FROM OLD."rawDisposedAt"
    AND NEW."rawDisposalReceipt" IS NOT DISTINCT FROM OLD."rawDisposalReceipt"
    AND NEW."rawArchiveFilesDeletedAt" IS NOT DISTINCT FROM OLD."rawArchiveFilesDeletedAt" THEN
   IF OLD."rawDisposedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
     RAISE EXCEPTION 'Disposed acquisition summaries are immutable';
   END IF;
   RETURN NEW;
 END IF;
 IF current_user<>'postgres' OR current_setting('career_dashboard.dispose_batch',true) IS DISTINCT FROM NEW.id
    OR (to_jsonb(NEW)-ARRAY['rawDisposedAt','rawDisposalReceipt','rawArchiveFilesDeletedAt'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['rawDisposedAt','rawDisposalReceipt','rawArchiveFilesDeletedAt']) THEN
   RAISE EXCEPTION 'Only dedicated maintenance may publish acquisition disposal receipts';
 END IF;
 IF OLD."rawDisposedAt" IS NULL THEN
   IF NEW."rawDisposedAt" IS NULL OR NEW."rawArchiveFilesDeletedAt" IS NOT NULL
      OR NOT ats_completed_disposal_eligible(NEW.id)
      OR NEW."rawDisposalReceipt"->>'policy' IS DISTINCT FROM 'completed-acquisition-v1'
      OR NEW."rawDisposalReceipt"->>'batchId' IS DISTINCT FROM NEW.id
      OR COALESCE(NEW."rawDisposalReceipt"->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(NEW."rawDisposalReceipt"->'rawCounts') IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'Acquisition disposal requires verified completed, superseded work';
   END IF;
 ELSE
   IF NEW."rawDisposedAt" IS DISTINCT FROM OLD."rawDisposedAt"
      OR NEW."rawDisposalReceipt" IS DISTINCT FROM OLD."rawDisposalReceipt"
      OR OLD."rawArchiveFilesDeletedAt" IS NOT NULL OR NEW."rawArchiveFilesDeletedAt" IS NULL
      OR OLD."archiveVerifiedAt" IS NULL THEN
     RAISE EXCEPTION 'Disposal receipts are immutable; only archive-file cleanup may finish';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "AtsIngestionBatch_raw_disposal_guard" BEFORE UPDATE ON "AtsIngestionBatch"
 FOR EACH ROW EXECUTE FUNCTION guard_ats_raw_disposal();

-- The publication trigger checks eligibility once under the batch row lock.
-- Per-row deletion checks only the immutable receipt, avoiding repeated segment scans.
CREATE OR REPLACE FUNCTION ats_verified_archive_delete_permitted(batch_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT current_user='postgres' AND EXISTS (
   SELECT 1 FROM "AtsIngestionBatch" b WHERE b.id=batch_id
     AND b."writerMode"='v2' AND b.status='processed' AND b."operatorResetAt" IS NULL
     AND ((current_setting('career_dashboard.dispose_batch',true)=batch_id
       AND b."rawDisposedAt" IS NOT NULL AND b."rawDisposalReceipt"->>'policy'='completed-acquisition-v1')
      OR (current_setting('career_dashboard.archive_batch',true)=batch_id
       AND b."processedAt" < (now() AT TIME ZONE 'UTC')-interval '30 days'
       AND b."archiveVerifiedAt" IS NOT NULL AND b."archiveBytes">0
       AND b."archiveContentHash" ~ '^[a-f0-9]{64}$'
       AND b."archiveLocation" ~ '^v1/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-f0-9-]{36}-[a-f0-9]{64}[.]json[.]gz$'))
 );
$$;

CREATE OR REPLACE FUNCTION guard_ats_archive_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD."archiveVerifiedAt" IS NOT NULL AND
    (to_jsonb(NEW)-ARRAY['rawDisposedAt','rawDisposalReceipt','rawArchiveFilesDeletedAt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['rawDisposedAt','rawDisposalReceipt','rawArchiveFilesDeletedAt']) THEN
   RAISE EXCEPTION 'Verified crawl archive receipts and completed summaries are immutable';
 END IF;
 IF OLD."archiveVerifiedAt" IS NULL AND NEW."archiveVerifiedAt" IS NOT NULL THEN
   IF current_user<>'postgres' OR current_setting('career_dashboard.archive_batch',true) IS DISTINCT FROM NEW.id
      OR NEW.status<>'processed' OR NEW."writerMode"<>'v2' OR NEW."operatorResetAt" IS NOT NULL
      OR NEW."rawDisposedAt" IS NOT NULL OR NEW."processedAt" IS NULL
      OR NEW."processedAt">=(now() AT TIME ZONE 'UTC')-interval '30 days'
      OR NEW."archiveBytes" IS NULL OR NEW."archiveBytes"<=0
      OR NEW."archiveContentHash" IS NULL OR NEW."archiveContentHash" !~ '^[a-f0-9]{64}$'
      OR NEW."archiveLocation" IS NULL OR NEW."archiveLocation" !~ '^v1/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-f0-9-]{36}-[a-f0-9]{64}[.]json[.]gz$' THEN
     RAISE EXCEPTION 'Crawl archival requires a verified completed-batch receipt';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE INDEX "AtsIngestionBatch_disposal_candidates_idx" ON "AtsIngestionBatch"("rawObservationCount" DESC,id)
 WHERE "writerMode"='v2' AND status='processed' AND "rawDisposedAt" IS NULL AND "operatorResetAt" IS NULL;
CREATE INDEX "AtsIngestionBatch_disposal_files_idx" ON "AtsIngestionBatch"(id)
 WHERE "rawDisposedAt" IS NOT NULL AND "archiveLocation" IS NOT NULL AND "rawArchiveFilesDeletedAt" IS NULL;
