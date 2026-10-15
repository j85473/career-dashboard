/**
 * Preview and apply verified metadata/location recovery. Defaults to read-only.
 * node scripts/with-env.mjs node --import tsx scripts/repair_posting_metadata.ts --out PRIVATE_DIR
 * ... --apply --plan PRIVATE_DIR/plan.json --selection-hash HASH --out PRIVATE_APPLY_DIR
 * Optional --restore-reviewed-job UUID identifies an explicitly reviewed manual
 * location rejection to return to Inbox without rescoring or clearing scores.
 */
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, type Job } from '../src/lib/prismaClient';
import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi, scrapeJobPostingMetadata } from '../src/lib/atsApi';
import { providerPostingLocation, hasIncompleteLocations } from '../src/lib/postingLocation';
import { hasExplicitUnitedStatesReference, hasMinneapolisMetroOption, isGeneralRemoteOption, hasResidencyRequirement, hasRegularPresenceRequirement, classifyRequiredWorkBaseEvidence } from '../src/lib/jobLocationPolicy';
import { isGenericManualImportTitle, isGenericManualImportCompany } from '../src/lib/manualImportPolicy';
import { planPostingMetadataRepair, automaticGeographyReason, repairHash, POSTING_METADATA_REPAIR_VERSION, type MetadataRepairEvidence } from '../src/lib/postingMetadataRepair';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { FINAL_USER_LIFECYCLE_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

type Planned = { job: Job; evidence: MetadataRepairEvidence; scoreHash: string; humanHash: string;
  target: NonNullable<ReturnType<typeof planPostingMetadataRepair>>; reviewedRestore: boolean };
type Plan = { version: string; rows: Planned[]; diagnostics: Record<string, number>; unresolved: Array<{id:string;reason:string}> };
const chunks = <T>(v:T[],n=200)=>Array.from({length:Math.ceil(v.length/n)},(_,i)=>v.slice(i*n,(i+1)*n));
const save=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
const hasScores=(job:Job,events:unknown[])=>events.length>0 || [job.fitScore,job.aimFitScore,job.reqFitScore,job.travelScore].some(v=>v!==null);
const restrictsBase=(job:Job)=> (job.description || '').split(/\n|(?<=[.!?])\s+/).some(line =>
  (hasResidencyRequirement(line) || hasRegularPresenceRequirement(line))
  && classifyRequiredWorkBaseEvidence([line]) !== 'compatible'
  && !/^(?:.*\b(?:must|need to|required to)\s+(?:live|reside|be located|be based)\s+(?:in\s+)?(?:the\s+)?(?:United States|USA|U\.S\.)[.!]?\s*)$/i.test(line));

async function authority(id:string,tx:Prisma.TransactionClient|typeof prisma=prisma) {
 const scores=await tx.jobScoreEvent.findMany({where:{jobId:id},orderBy:{id:'asc'}});
 const humans=await tx.jobPipelineEvent.findMany({where:{jobId:id,eventType:{in:[...FINAL_USER_LIFECYCLE_EVENT_TYPES]}},orderBy:{id:'asc'}});
 return {scores,humans,scoreHash:repairHash(scores),humanHash:repairHash(humans)};
}
async function build(out:string,reviewed:Set<string>,resume=false):Promise<Plan> {
 const diagnostics:Record<string,number>={rawReceipts:0,sourceFetches:0,loadedJobs:0,restores:0,metadataOnly:0};
 const unresolved:Plan['unresolved']=[];
 const evidence=new Map<string,MetadataRepairEvidence>();
 // Retained raw downloads prove secondary sites existed before the rejection.
 // Latest completed batch per tenant avoids mixing superseded requisitions.
 console.log('Reading complete location arrays from retained provider downloads');
 const raw: Array<{id:string;raw:Prisma.JsonValue;batchId:string;rawHash:string}> = resume && existsSync(`${out}/downloads.json`)
 ? JSON.parse(readFileSync(`${out}/downloads.json`,'utf8'))
 : await prisma.$queryRaw(Prisma.sql`
 WITH latest AS MATERIALIZED (
 SELECT DISTINCT ON (platform,slug) id,platform,"activeLedgerGeneration" FROM "AtsIngestionBatch"
 WHERE platform IN ('ashby','lever') AND status='processed'
 ORDER BY platform,slug,"createdAt" DESC,id DESC
 ), raw AS MATERIALIZED (
 SELECT b.platform,i."providerSourceId",i."batchId",i."rawHash",
 jsonb_build_object('title',COALESCE(i."rawJson",o."rawJson")->'title',
 'text',COALESCE(i."rawJson",o."rawJson")->'text',
 'location',COALESCE(i."rawJson",o."rawJson")->'location',
 'secondaryLocations',COALESCE(i."rawJson",o."rawJson")->'secondaryLocations',
 'categories',COALESCE(i."rawJson",o."rawJson")->'categories') AS body
 FROM latest b JOIN "AtsIngestionItem" i ON i."batchId"=b.id AND i."ledgerGeneration"=b."activeLedgerGeneration"
 LEFT JOIN "AtsListingObservation" o ON i."rawJson" IS NULL AND o.id=i."representativeObservationId"
 WHERE jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(i."rawJson",o."rawJson")->'secondaryLocations')='array' THEN COALESCE(i."rawJson",o."rawJson")->'secondaryLocations' ELSE '[]'::jsonb END)>0
 OR jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(i."rawJson",o."rawJson")->'categories'->'allLocations')='array' THEN COALESCE(i."rawJson",o."rawJson")->'categories'->'allLocations' ELSE '[]'::jsonb END)>1
 ) SELECT j.id,r.body AS raw,r."batchId",r."rawHash"
 FROM raw r JOIN "JobSourceObservation" s ON s.source='ATS-'||r.platform AND s."sourceId"=r."providerSourceId"
 JOIN "Job" j ON j.id=s."jobId" AND j.source=s.source AND j."sourceId"=s."sourceId"`);
 if(!existsSync(`${out}/downloads.json`))save(`${out}/downloads.json`,raw);
 diagnostics.rawReceipts=raw.length;
 for(const row of raw) {
  const job=row.raw as Parameters<typeof providerPostingLocation>[0] & {title?:string;text?:string};
  if(!job)continue;
  const location=providerPostingLocation(job);
  if(location)evidence.set(row.id,{location,title:job.title||job.text,identityVerified:true,completeLocations:!hasIncompleteLocations(location),source:`retained-download:${row.batchId}:${row.rawHash}`});
 }
 // Labels are small indexed-row fields: never scan every toasted JD to find candidates.
 const ids=await prisma.$queryRaw<Array<{id:string}>>(Prisma.sql`
 SELECT id FROM "Job" WHERE source='Manual Import'
 OR title ~* '^(Recruitment|Career Center[ |:-]*Recruitment|Manual Job Import)$'
 OR ("passReason" ~* '^(Locally triaged out: Location outside|International location rejected|Location rejected|Outstate MN location rejected)' AND location ~* '(remote|Minneapolis|St[.]? Paul|Saint Paul|Plymouth|Blaine|Hugo|Andover|Apple Valley|Farmington|Anoka|Rosemount|Lake Elmo|Lino Lakes|Ramsey|Brooklyn Park|Maple Grove)')
 OR (source IN ('ATS-breezy','ATS-teamtailor','TheMuse') AND title ~* '(channel|partner|account manager|customer success|sales manager|sales director)' AND (status IN ('inbox','pending_af') OR "passReason" LIKE 'Locally triaged out: Location%'))`);
 const selected=[...new Set([...ids.map(row=>row.id),...evidence.keys(),...reviewed])];
 const jobs:Job[]=resume && existsSync(`${out}/candidates.json`) ? JSON.parse(readFileSync(`${out}/candidates.json`,'utf8')) : [];
 if(!jobs.length)for(const batch of chunks(selected))jobs.push(...await prisma.job.findMany({where:{id:{in:batch}},orderBy:{id:'asc'}}));
 if(!existsSync(`${out}/candidates.json`))save(`${out}/candidates.json`,jobs);
 const checked = new Set<string>();
 if(resume && existsSync(`${out}/network-evidence.jsonl`))for(const line of readFileSync(`${out}/network-evidence.jsonl`,'utf8').split('\n').filter(Boolean)) {
  const row=JSON.parse(line);checked.add(row.id);
  if(row.proof)evidence.set(row.id,row.proof);else unresolved.push({id:row.id,reason:'Exact posting metadata unavailable; saved work retained'});
 }
 diagnostics.loadedJobs=jobs.length;
 // Fetch provider details only for gaps which retained downloads cannot settle.
 const fetchJobs=jobs.filter(job=>job.url && !evidence.has(job.id) && !checked.has(job.id) &&
  (job.source==='Manual Import' || isGenericManualImportTitle(job.title)
   || (['ATS-breezy','ATS-teamtailor','TheMuse'].includes(job.source||'') && /channel|partner|account manager|customer success|sales manager|sales director/i.test(job.title))));
 console.log(`Checking ${fetchJobs.length} exact posting URLs; ${raw.length} retained multi-site downloads`);
 for(const batch of chunks(fetchJobs,12)) {
  const results=await Promise.all(batch.map(async job=>{
   diagnostics.sourceFetches++;
   const result=await (['ATS-breezy','ATS-teamtailor','TheMuse'].includes(job.source||'')
     ? scrapeJobPostingMetadata(job.url!) : scrapeAtsApi(job.url!)).catch(()=>null);
   return {job,result};
  }));
  for(const {job,result} of results) {
   if(result?.location)evidence.set(job.id,{location:result.location,title:result.title,company:result.company,identityVerified:true,
    completeLocations:!hasIncompleteLocations(result.location),source:`exact-posting:${job.url}`});
   else unresolved.push({id:job.id,reason:'Exact posting did not provide verifiable location metadata; saved work retained'});
   appendFileSync(`${out}/network-evidence.jsonl`,JSON.stringify({id:job.id,proof:evidence.get(job.id)||null})+'\n',{mode:0o600});
  }
  console.log(`Posting checks ${Math.min(diagnostics.sourceFetches,fetchJobs.length)}/${fetchJobs.length}`);
 }
 const plan:Plan={version:POSTING_METADATA_REPAIR_VERSION,rows:[],diagnostics,unresolved};
 for(const job of jobs) {
  let proof=evidence.get(job.id);
  if(!proof && job.location && isGeneralRemoteOption(job.location) && hasExplicitUnitedStatesReference(job.location)) {
   proof={location:job.location,identityVerified:true,completeLocations:true,source:'explicit-US-remote-metadata'};
  }
  // Known local metadata can repair old automatic city-list failures without
  // fetching an unrelated URL; the entire original field remains available.
  if(!proof && job.location && automaticGeographyReason(job.passReason)) {
   const confirmedMetro = /\b(?:MN|Minnesota)\b/i.test(job.location) && (hasMinneapolisMetroOption(job.location)
    || /\b(?:Blaine|Hugo|Andover|Apple Valley|Anoka|Farmington|Rosemount|Lake Elmo|Lino Lakes|Ramsey|Saint Michael)\b/i.test(job.location));
   proof={location:job.location,identityVerified:true,completeLocations:confirmedMetro && !hasIncompleteLocations(job.location),source:'stored-location-policy-repair'};
  }
  if(!proof)continue;
  if(!reviewed.has(job.id) && restrictsBase(job))proof={...proof,completeLocations:false};
  if(!planPostingMetadataRepair(job,proof,{hasScores:false,hasHumanDecision:false,reviewedRestore:reviewed.has(job.id)}))continue;
  if(job.jdBatchId||job.batchJobId||job.afBatchId){unresolved.push({id:job.id,reason:'Active legacy scoring/JD lease; retry after release'});continue;}
  if(await prisma.scoringBatchItem.count({where:{jobId:job.id,status:'leased'}})){unresolved.push({id:job.id,reason:'Active scoring batch lease; retry after release'});continue;}
  const state=await authority(job.id);
  const target=planPostingMetadataRepair(job,proof,{hasScores:hasScores(job,state.scores),hasHumanDecision:state.humans.length>0,reviewedRestore:reviewed.has(job.id)});
  if(!target)continue;
  // Never replay generic metadata over an existing specific employer/title.
  if(target.metadata.company && !isGenericManualImportCompany(job.company,job.url))throw new Error('Unsafe employer overwrite');
  plan.rows.push({job,evidence:proof,target,scoreHash:state.scoreHash,humanHash:state.humanHash,reviewedRestore:reviewed.has(job.id)});
  diagnostics[target.action==='restore_for_review'?'restores':'metadataOnly']++;
 }
 save(`${out}/sources.json`,[...evidence].map(([id,proof])=>({id,proof})));
 save(`${out}/plan.json`,plan);
 save(`${out}/preview.json`,{selectionHash:repairHash(plan),diagnostics,unresolved:unresolved.length});
 console.log(JSON.stringify({selectionHash:repairHash(plan),diagnostics,unresolved:unresolved.length}));
 return plan;
}
async function apply(plan:Plan,out:string,approved:string) {
 if(plan.version!==POSTING_METADATA_REPAIR_VERSION || repairHash(plan)!==approved)throw new Error('The saved plan or selection hash changed');
 save(`${out}/plan.json`,plan);
 const results:Array<{id:string;result:string}>=[];
 for(const row of plan.rows) {
  const result=await prisma.$transaction(async tx=>{
   const locked=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "Job" WHERE id=${row.job.id} FOR UPDATE`;
   if(!locked.length)return 'missing';
   const current=await tx.job.findUniqueOrThrow({where:{id:row.job.id}});
   if(repairHash(current)!==repairHash(row.job))return 'changed_since_preview';
   if(current.jdBatchId||current.batchJobId||current.afBatchId||await tx.scoringBatchItem.count({where:{jobId:current.id,status:'leased'}}))return 'active_lease';
   const before=await authority(current.id,tx);
   if(before.scoreHash!==row.scoreHash||before.humanHash!==row.humanHash)return 'authority_changed';
   const recomputed=planPostingMetadataRepair(current,row.evidence,{hasScores:hasScores(current,before.scores),hasHumanDecision:before.humans.length>0,reviewedRestore:row.reviewedRestore});
   if(repairHash(recomputed)!==repairHash(row.target))throw new Error('Repair target does not match planner');
   appendFileSync(`${out}/before.jsonl`,JSON.stringify({job:current,scores:before.scores,humanEvents:before.humans})+'\n',{mode:0o600});
   const data:Prisma.JobUpdateManyMutationInput={...row.target.metadata,...row.target.lifecycle};
   if(row.target.lifecycle) { data.contextBatched=true; data.contextBatchId=null; }
   data.identityFingerprint=generateV4Fingerprint(row.target.metadata.title||current.title,row.target.metadata.company||current.company,row.target.metadata.location||current.location||'unknown');
   const changed=await tx.job.updateMany({where:{id:current.id,updatedAt:current.updatedAt},data});
   if(changed.count!==1)throw new Error('Concurrent metadata mutation');
   await recordJobPipelineEvent({eventType:row.reviewedRestore && row.target.lifecycle ? 'user_promote' : 'metadata_repaired',
    jobId:current.id,source:current.source,sourceId:current.sourceId,stage:'metadata',
    identityParts:[POSTING_METADATA_REPAIR_VERSION,approved,current.id],details:{route:POSTING_METADATA_REPAIR_VERSION,
     action:row.target.action,evidence:row.evidence,priorStatus:current.status,nextStatus:row.target.lifecycle?.status||current.status,
     ...(row.reviewedRestore?{actor:'user',protected:true,nextTailoringStaged:current.tailoringStaged}:{}),scoresPreserved:true}},tx);
   const after=await tx.job.findUniqueOrThrow({where:{id:current.id}});
   const allowed=new Set(['title','company','employer','location','identityFingerprint','updatedAt',...(row.target.lifecycle?['status','scoringStatus','passReason','contextBatched','contextBatchId']:[])]);
   for(const key of Object.keys(current) as Array<keyof Job>)if(!allowed.has(key)&&repairHash(current[key])!==repairHash(after[key]))throw new Error(`Protected field changed: ${key}`);
   if(repairHash(await tx.jobScoreEvent.findMany({where:{jobId:current.id},orderBy:{id:'asc'}}))!==before.scoreHash)throw new Error('Score history changed');
   return row.target.action;
  },{maxWait:10000,timeout:30000});
  results.push({id:row.job.id,result});
  appendFileSync(`${out}/results.jsonl`,JSON.stringify(results.at(-1))+'\n',{mode:0o600});
 }
 const counts=Object.fromEntries([...new Set(results.map(r=>r.result))].map(result=>[result,results.filter(r=>r.result===result).length]));
 save(`${out}/report.json`,{selectionHash:approved,counts,results,scoreFieldsAndEventsPreserved:true});
 console.log(JSON.stringify({selectionHash:approved,counts,scoreFieldsAndEventsPreserved:true}));
}
async function main(){
 const args=process.argv.slice(2);const value=(name:string)=>args[args.indexOf(name)+1];
 for(let i=0;i<args.length;i++)if(['--apply','--resume'].includes(args[i]))continue;else if(['--out','--plan','--selection-hash','--restore-reviewed-job'].includes(args[i])){if(!args[++i])throw new Error('Missing argument');}else throw new Error(`Unknown argument: ${args[i]}`);
 if(!args.includes('--out'))throw new Error('--out private backup/report directory required');
 const out=resolve(value('--out'));mkdirSync(out,{recursive:true,mode:0o700});
 if(!args.includes('--apply')&&!args.includes('--resume')&&existsSync(`${out}/downloads.json`))throw new Error('Preview already started; use --resume to reuse saved evidence');
 if(args.includes('--apply')){
  if(!args.includes('--plan')||!args.includes('--selection-hash'))throw new Error('Apply requires saved --plan and exact --selection-hash');
  await apply(JSON.parse(readFileSync(resolve(value('--plan')),'utf8')),out,value('--selection-hash'));
 }else await build(out,new Set(args.flatMap((a,i)=>a==='--restore-reviewed-job'?[args[i+1]]:[])),args.includes('--resume'));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
