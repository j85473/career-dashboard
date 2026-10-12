\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';
SELECT pg_advisory_xact_lock(912837466);
LOCK TABLE "AtsCompany", "AtsIngestionBatch", "AtsAcquisitionWorkReceipt", "AtsIngestionSegment" IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE actions(slug text,platform text,reason text,survivor text,"survivorPlatform" text) ON COMMIT DROP;
INSERT INTO actions VALUES ('micron.wd1::external','workday','Same board as micron.wd1::External with different capitals; live provider responses resolve both addresses to site External, with identical first-page IDs, total 3184, and underlying posting identity (operator_verified_alias_consolidation_20261012).','micron.wd1::External','workday'),
('nvidia.wd5::nvidiaexternalcareersite','workday','Same board as nvidia.wd5::NVIDIAExternalCareerSite with different capitals; live provider responses resolve both addresses to site NVIDIAExternalCareerSite, with identical first-page IDs, total 2000, and underlying posting identity (operator_verified_alias_consolidation_20261012).','nvidia.wd5::NVIDIAExternalCareerSite','workday'),
('ms.wd5::external','workday','Same board as ms.wd5::External with different capitals; live provider responses resolve both addresses to site External, with identical first-page IDs, total 1282, and underlying posting identity (operator_verified_alias_consolidation_20261012).','ms.wd5::External','workday'),
('bristolmyerssquibb.wd5::bms','workday','Same board as bristolmyerssquibb.wd5::BMS with different capitals; live provider responses resolve both addresses to site BMS, with identical first-page IDs, total 717, and underlying posting identity (operator_verified_alias_consolidation_20261012).','bristolmyerssquibb.wd5::BMS','workday'),
('astrazeneca.wd3::careers','workday','Same board as astrazeneca.wd3::Careers with different capitals; live provider responses resolve both addresses to site Careers, with identical first-page IDs, total 1112, and underlying posting identity (operator_verified_alias_consolidation_20261012).','astrazeneca.wd3::Careers','workday'),
('dexcom.wd1::dexcom','workday','Same board as dexcom.wd1::Dexcom with different capitals; live provider responses resolve both addresses to site Dexcom, with identical first-page IDs, total 276, and underlying posting identity (operator_verified_alias_consolidation_20261012).','dexcom.wd1::Dexcom','workday'),
('trimble.wd1::trimblecareers','workday','Same board as trimble.wd1::TrimbleCareers with different capitals; live provider responses resolve both addresses to site TrimbleCareers, with identical first-page IDs, total 208, and underlying posting identity (operator_verified_alias_consolidation_20261012).','trimble.wd1::TrimbleCareers','workday'),
('hp.wd5::externalcareersite','workday','Same board as hp.wd5::ExternalCareerSite with different capitals; live provider responses resolve both addresses to site ExternalCareerSite, with identical first-page IDs, total 876, and underlying posting identity (operator_verified_alias_consolidation_20261012).','hp.wd5::ExternalCareerSite','workday'),
('hp.wd5::exteu-ac-careersite','workday','Same board as hp.wd5::EXTEU-AC-CareerSite with different capitals; live provider responses resolve both addresses to site EXTEU-AC-CareerSite, with identical first-page IDs, total 1207, and underlying posting identity (operator_verified_alias_consolidation_20261012).','hp.wd5::EXTEU-AC-CareerSite','workday'),
('trimble.eightfold.ai','eightfold','operator_single_source_coverage_20261012: Joe requested one collection source without losing openings; full current Eightfold inventory has 192 distinct requisitions, all 192 present in Workday TrimbleCareers current inventory of 208. Retain Workday. Saved jobs and scores unchanged.','trimble.wd1::TrimbleCareers','workday');
DO $$ BEGIN
 IF (SELECT count(*) FROM "AtsCompany" a JOIN actions x USING(slug,platform)) <> (SELECT count(*) FROM actions) THEN RAISE EXCEPTION 'Exact target selection changed'; END IF;
 IF EXISTS(SELECT 1 FROM actions x WHERE x.survivor<>'' AND NOT EXISTS (SELECT 1 FROM "AtsCompany" a WHERE a.slug=x.survivor AND a.platform=x."survivorPlatform" AND a.status='active')) THEN RAISE EXCEPTION 'Required survivor not active'; END IF;
 IF EXISTS(SELECT 1 FROM "AtsIngestionBatch" b JOIN actions x USING(slug,platform) WHERE b.status IN ('fetching','partial','synchronized','reset_draining')) THEN RAISE EXCEPTION 'Target has unfinished acquired work; retirement refused'; END IF;
 PERFORM 1 FROM "Job" WHERE company IN ('HP','HP - Sandbox','HP - Dry Run','HP - Dev','Micron Technology','NVIDIA','NVIDIA Corporation','Morgan Stanley','Bristol Myers Squibb','AstraZeneca','Dexcom','Trimble') OR employer IN ('HP','Micron Technology','NVIDIA','NVIDIA Corporation','Morgan Stanley','Bristol Myers Squibb','AstraZeneca','Dexcom','Trimble') FOR SHARE;
END $$;
CREATE TEMP TABLE before_boards ON COMMIT DROP AS SELECT a.* FROM "AtsCompany" a JOIN actions x USING(slug,platform);
CREATE TEMP TABLE before_jobs ON COMMIT DROP AS SELECT j.id,md5(row_to_json(j)::text) AS hash FROM "Job" j WHERE company IN ('HP','HP - Sandbox','HP - Dry Run','HP - Dev','Micron Technology','NVIDIA','NVIDIA Corporation','Morgan Stanley','Bristol Myers Squibb','AstraZeneca','Dexcom','Trimble') OR employer IN ('HP','Micron Technology','NVIDIA','NVIDIA Corporation','Morgan Stanley','Bristol Myers Squibb','AstraZeneca','Dexcom','Trimble');
CREATE TEMP TABLE before_scores ON COMMIT DROP AS SELECT e.id,md5(row_to_json(e)::text) AS hash FROM "JobScoreEvent" e JOIN before_jobs j ON j.id=e."jobId";
CREATE TEMP TABLE survivors ON COMMIT DROP AS SELECT a.slug,a.platform,md5(row_to_json(a)::text) AS hash FROM "AtsCompany" a WHERE EXISTS(SELECT 1 FROM actions x WHERE x.survivor=a.slug AND x."survivorPlatform"=a.platform);
SELECT json_build_object('mode','preview','actions',(SELECT json_agg(row_to_json(x)) FROM actions x),'saved_jobs',(SELECT count(*) FROM before_jobs),'score_events',(SELECT count(*) FROM before_scores));
\if :apply
UPDATE "AtsCompany" a SET status='excluded',"excludedReason"=x.reason,"excludedAt"=now() FROM actions x WHERE a.slug=x.slug AND a.platform=x.platform AND a.status<>'excluded';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM before_jobs p LEFT JOIN "Job" j USING(id) WHERE j.id IS NULL OR md5(row_to_json(j)::text)<>p.hash)
 OR EXISTS(SELECT 1 FROM before_scores p LEFT JOIN "JobScoreEvent" e USING(id) WHERE e.id IS NULL OR md5(row_to_json(e)::text)<>p.hash)
 OR EXISTS(SELECT 1 FROM survivors p LEFT JOIN "AtsCompany" a USING(slug,platform) WHERE a.slug IS NULL OR md5(row_to_json(a)::text)<>p.hash) THEN RAISE EXCEPTION 'Preservation check failed'; END IF;
 IF EXISTS(SELECT 1 FROM "AtsCompany" a JOIN actions x USING(slug,platform) WHERE a.status<>'excluded') THEN RAISE EXCEPTION 'Selected source remains active'; END IF;
END $$;
INSERT INTO "JobPipelineEvent"(id,"eventKey","eventType",stage,source,"sourceId",details,"occurredAt","createdAt")
VALUES ('76583d20-2663-4a3d-8340-9d8e8ebbe49e','operator:ats-source-consolidation:20261012:case-aliases-trimble','ats_sources_consolidated','acquisition','operator','20261012',json_build_object('actor','user','actions',(SELECT json_agg(row_to_json(x)) FROM actions x),'boards_before',(SELECT json_agg(row_to_json(a)) FROM before_boards a),'preserved_jobs',(SELECT count(*) FROM before_jobs),'preserved_score_events',(SELECT count(*) FROM before_scores),'preservation_verified',true)::jsonb,now(),now()) ON CONFLICT("eventKey") DO NOTHING;
SELECT json_build_object('mode','applied','excluded_sources',(SELECT count(*) FROM actions),'preserved_jobs',(SELECT count(*) FROM before_jobs),'preserved_score_events',(SELECT count(*) FROM before_scores),'preservation_verified',true);
COMMIT;
\else
ROLLBACK;
\endif
