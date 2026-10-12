-- Exact operator-requested retirement: HP Eightfold duplicates HP Workday.
-- Run with psql -v apply=false first, then -v apply=true. ON_ERROR_STOP required.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(912837466);
SELECT pg_advisory_xact_lock(hashtextextended('["eightfold","hp.eightfold.ai"]', 0));
LOCK TABLE "AtsCompany", "AtsIngestionBatch", "AtsAcquisitionWorkReceipt", "AtsIngestionSegment", "AtsEndpointSweepReceipt" IN SHARE ROW EXCLUSIVE MODE;
SELECT set_config('career_dashboard.ats_v2_writer', '2', true);

CREATE TEMP TABLE retirement_boards ON COMMIT DROP AS
SELECT * FROM "AtsCompany" WHERE platform='eightfold' AND lower(slug)='hp.eightfold.ai';
CREATE TEMP TABLE retirement_batches ON COMMIT DROP AS
SELECT b.* FROM "AtsIngestionBatch" b JOIN retirement_boards a USING (slug,platform)
WHERE b.status IN ('fetching','partial','synchronized','reset_draining');

DO $$ BEGIN
  IF (SELECT count(*) FROM retirement_boards) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one verified production HP Eightfold token';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AtsCompany" WHERE platform='workday' AND lower(slug)='hp.wd5::externalcareersite' AND status='active') THEN
    RAISE EXCEPTION 'HP Workday replacement is not active';
  END IF;
  IF EXISTS (SELECT 1 FROM retirement_batches WHERE
    "acquisitionClaimToken" IS NOT NULL OR "leaseToken" IS NOT NULL) THEN
    RAISE EXCEPTION 'Target batch has a live or unresolved claim; retirement refused';
  END IF;
  IF EXISTS (SELECT 1 FROM "AtsAcquisitionWorkReceipt" WHERE "batchId" IN (SELECT id FROM retirement_batches) AND "finishedAt" IS NULL) THEN
    RAISE EXCEPTION 'Target batch has unfinished worker receipts; retirement refused';
  END IF;
  IF EXISTS (SELECT 1 FROM "AtsIngestionSegment" WHERE "batchId" IN (SELECT id FROM retirement_batches) AND status <> 'processed') THEN
    RAISE EXCEPTION 'Target batch has a published or unfinished persistence segment; retirement refused';
  END IF;
  PERFORM 1 FROM "Job" WHERE company='HP' OR employer='HP'
    OR id IN ('eeb8c706-dd06-4809-a3f2-e672e4febd36','abc940ec-6d1c-4151-8777-d28b18aaad4d') FOR SHARE;
  PERFORM 1 FROM "AtsCompany" WHERE platform='workday' AND lower(slug)='hp.wd5::externalcareersite' FOR SHARE;
END $$;

CREATE TEMP TABLE preserved_jobs ON COMMIT DROP AS
SELECT id,md5(row_to_json(j)::text) AS hash FROM "Job" j WHERE company='HP' OR employer='HP'
OR id IN ('eeb8c706-dd06-4809-a3f2-e672e4febd36','abc940ec-6d1c-4151-8777-d28b18aaad4d');
CREATE TEMP TABLE preserved_scores ON COMMIT DROP AS
SELECT e.id,md5(row_to_json(e)::text) AS hash FROM "JobScoreEvent" e JOIN preserved_jobs j ON j.id=e."jobId";
CREATE TEMP TABLE preserved_workday ON COMMIT DROP AS
SELECT slug,platform,md5(row_to_json(a)::text) AS hash FROM "AtsCompany" a
WHERE platform='workday' AND lower(slug)='hp.wd5::externalcareersite';
CREATE TEMP TABLE preserved_observations ON COMMIT DROP AS
SELECT o.id,md5(row_to_json(o)::text) AS hash FROM "AtsListingObservation" o
WHERE "batchId" IN (SELECT id FROM retirement_batches);
CREATE TEMP TABLE preserved_items ON COMMIT DROP AS
SELECT i.id,md5(row_to_json(i)::text) AS hash FROM "AtsIngestionItem" i
WHERE "batchId" IN (SELECT id FROM retirement_batches);

SELECT json_build_object('mode','preview','boards',(SELECT json_agg(row_to_json(a)) FROM retirement_boards a),
 'unfinished_batches',(SELECT json_agg(json_build_object('id',id,'status',status,'downloaded',"rawObservationCount",'inserted',"insertedCount")) FROM retirement_batches),
 'saved_jobs',(SELECT count(*) FROM preserved_jobs),'score_events',(SELECT count(*) FROM preserved_scores),
 'observations_retained',(SELECT count(*) FROM preserved_observations),'items_retained',(SELECT count(*) FROM preserved_items),
 'workday_boards_preserved',(SELECT count(*) FROM preserved_workday));

\if :apply
UPDATE "AtsIngestionBatch" SET status='excluded',
 "lastError"='operator_permanent_retirement_hp_eightfold_20261012: duplicate acquisition path; HP Workday retained',
 "updatedAt"=now() WHERE id IN (SELECT id FROM retirement_batches);
UPDATE "AtsEndpointSweepReceipt" SET state='failed',outcome='operator_permanent_retirement_duplicate_source',"updatedAt"=now()
WHERE "batchId" IN (SELECT id FROM retirement_batches) AND state NOT IN ('succeeded','failed');
UPDATE "AtsCompany" SET status='excluded',"excludedAt"=now(),
 "excludedReason"='operator_permanent_retirement_hp_eightfold_20261012: Joe requested retirement of redundant HP Eightfold collection; HP Workday hp.wd5::ExternalCareerSite retained. Verified Eightfold listing 44447638 displays Workday requisition 3168539 and Apply Now opens that exact Workday application.'
WHERE platform='eightfold' AND lower(slug)='hp.eightfold.ai' AND status <> 'excluded';

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM preserved_jobs p LEFT JOIN "Job" j USING(id) WHERE j.id IS NULL OR md5(row_to_json(j)::text) <> p.hash)
 OR EXISTS (SELECT 1 FROM preserved_scores p LEFT JOIN "JobScoreEvent" e USING(id) WHERE e.id IS NULL OR md5(row_to_json(e)::text) <> p.hash)
 OR EXISTS (SELECT 1 FROM preserved_workday p LEFT JOIN "AtsCompany" a USING(slug,platform) WHERE a.slug IS NULL OR md5(row_to_json(a)::text) <> p.hash)
 OR EXISTS (SELECT 1 FROM preserved_observations p LEFT JOIN "AtsListingObservation" o USING(id) WHERE o.id IS NULL OR md5(row_to_json(o)::text) <> p.hash)
 OR EXISTS (SELECT 1 FROM preserved_items p LEFT JOIN "AtsIngestionItem" i USING(id) WHERE i.id IS NULL OR md5(row_to_json(i)::text) <> p.hash) THEN
   RAISE EXCEPTION 'Preservation check failed; rolling back retirement';
 END IF;
 IF EXISTS (SELECT 1 FROM "AtsCompany" WHERE platform='eightfold' AND lower(slug)='hp.eightfold.ai' AND status<>'excluded')
 OR EXISTS (SELECT 1 FROM "AtsIngestionBatch" WHERE id IN (SELECT id FROM retirement_batches) AND status<>'excluded') THEN
   RAISE EXCEPTION 'Retirement verification failed';
 END IF;
END $$;

INSERT INTO "JobPipelineEvent" (id,"eventKey","eventType",stage,source,"sourceId",details,"occurredAt","createdAt")
VALUES ('f3a6f249-2c84-4a58-a996-93f6eaf3dd08','operator:hp-eightfold-retirement:2026-10-12',
 'ats_board_retired','acquisition','ATS-eightfold','hp.eightfold.ai',
 json_build_object('actor','user','reason','Retire duplicate HP Eightfold collection; retain HP Workday',
 'board_before',(SELECT row_to_json(a) FROM retirement_boards a),
 'batch_before',(SELECT json_agg(row_to_json(b)) FROM retirement_batches b),
 'preserved_jobs',(SELECT count(*) FROM preserved_jobs),'preserved_score_events',(SELECT count(*) FROM preserved_scores),
 'retained_observations',(SELECT count(*) FROM preserved_observations),'retained_items',(SELECT count(*) FROM preserved_items),
 'unchanged_workday_boards',(SELECT count(*) FROM preserved_workday),
 'preservation_verified',true,'source_requisition','3168539','eightfold_listing','44447638')::jsonb,now(),now())
ON CONFLICT ("eventKey") DO NOTHING;

SELECT json_build_object('mode','applied','excluded_boards',(SELECT count(*) FROM "AtsCompany" WHERE platform='eightfold' AND lower(slug)='hp.eightfold.ai' AND status='excluded'),
 'excluded_batches',(SELECT count(*) FROM retirement_batches),'preserved_jobs',(SELECT count(*) FROM preserved_jobs),
 'preserved_score_events',(SELECT count(*) FROM preserved_scores),'retained_observations',(SELECT count(*) FROM preserved_observations),
 'unchanged_workday_boards',(SELECT count(*) FROM preserved_workday),'preservation_verified',true);
COMMIT;
\else
ROLLBACK;
\endif
