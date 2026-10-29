/** Receipt-backed, read-only throughput window. Never claims work or launches a browser. */
import { writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { Prisma } from '../src/lib/prismaClient';
import { NON_API_ATS_PLATFORMS } from '../src/lib/browserAtsBoards';
const costKeys=['listingMs','detailMs','ingestionMs','httpListings','httpDetails','browserListings','browserDetails','knownBeforeDetail','titleRejectedBeforeDetail'] as const;
type CostKey=typeof costKeys[number];
type CostTotals=Record<CostKey,number|null>&{instrumentedTurns:number};
type ThroughputTotals={firstCollections:number;distinctCompleted:number;turns:number;postings:number;inserted:number;duplicates:number;filtered:number;errors:number;completed:number};
type BenchmarkRow=ThroughputTotals&CostTotals&{source:string;seconds:number};
async function main() {
  const args=process.argv.slice(2);
  if(args.some(a=>!/^--(?:since|until|output)=.+$/.test(a))) throw Error('Usage: benchmark_ats_crawling.ts --since=ISO --until=ISO [--output=file]');
  const value=(name:string)=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  const since=new Date(value('since')||''),until=new Date(value('until')||'');
  if(!Number.isFinite(+since)||!Number.isFinite(+until)||+until<=+since)throw Error('Supply a positive, explicit UTC benchmark window');
  const sources=NON_API_ATS_PLATFORMS.map(p=>p==='gusto'?'Gusto':`ATS-${p}`);
  const rows=await prisma.$queryRaw<BenchmarkRow[]>(Prisma.sql`
    WITH window_runs AS (
      SELECT *,checkpoint->'crawl'->'cost' AS cost FROM "IngestionSourceRun"
      WHERE source IN (${Prisma.join(sources)}) AND "ingestionMode"='public-board'
        AND "createdAt">=(${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND "startedAt">=(${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND "finishedAt"<=(${until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    ), measured_runs AS (
      SELECT *,NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY[${Prisma.join([...costKeys])}]::text[]) AS metric(key)
        WHERE jsonb_typeof(cost->metric.key) IS DISTINCT FROM 'number'
      ) AS instrumented FROM window_runs
    )
    SELECT source,
      count(*) FILTER(WHERE checkpoint->'crawl'->>'firstCollectionCompleted'='true')::int AS "firstCollections",
      count(DISTINCT checkpoint->'crawl'->>'board') FILTER(WHERE checkpoint->'crawl'->>'complete'='true')::int AS "distinctCompleted",
      count(*)::int AS turns,COALESCE(sum("seenCount"),0)::int AS postings,
      COALESCE(sum("insertedCount"),0)::int AS inserted,COALESCE(sum("duplicateCount"),0)::int AS duplicates,
      COALESCE(sum("filteredCount"),0)::int AS filtered,count(*) FILTER(WHERE "requestErrorCount">0 OR "processingErrorCount">0)::int AS errors,
      COALESCE(sum(CASE WHEN checkpoint->'crawl'->>'complete'='true' THEN 1 ELSE 0 END+COALESCE((checkpoint->'crawl'->>'completedBoards')::int,0)),0)::int AS completed,
      COALESCE(sum("durationMs"),0)::float8/1000 AS seconds,
      count(*) FILTER(WHERE instrumented)::int AS "instrumentedTurns",
      sum(CASE WHEN instrumented THEN (cost->>'listingMs')::float8 END) AS "listingMs",
      sum(CASE WHEN instrumented THEN (cost->>'detailMs')::float8 END) AS "detailMs",
      sum(CASE WHEN instrumented THEN (cost->>'ingestionMs')::float8 END) AS "ingestionMs",
      sum(CASE WHEN instrumented THEN (cost->>'httpListings')::float8 END) AS "httpListings",
      sum(CASE WHEN instrumented THEN (cost->>'httpDetails')::float8 END) AS "httpDetails",
      sum(CASE WHEN instrumented THEN (cost->>'browserListings')::float8 END) AS "browserListings",
      sum(CASE WHEN instrumented THEN (cost->>'browserDetails')::float8 END) AS "browserDetails",
      sum(CASE WHEN instrumented THEN (cost->>'knownBeforeDetail')::float8 END) AS "knownBeforeDetail",
      sum(CASE WHEN instrumented THEN (cost->>'titleRejectedBeforeDetail')::float8 END) AS "titleRejectedBeforeDetail"
    FROM measured_runs GROUP BY source ORDER BY source
  `);
  const legacy=await prisma.atsCompany.count({where:{platform:{in:[...NON_API_ATS_PLATFORMS]},lastSynchronizedAt:{gte:since,lte:until}}});
  const totals=rows.reduce<ThroughputTotals&CostTotals>((a,r)=>{
    a.firstCollections+=r.firstCollections;a.distinctCompleted+=r.distinctCompleted;a.turns+=r.turns;a.postings+=r.postings;a.inserted+=r.inserted;a.duplicates+=r.duplicates;
    a.filtered+=r.filtered;a.errors+=r.errors;a.completed+=r.completed;a.instrumentedTurns+=r.instrumentedTurns;
    for(const key of costKeys)if(r[key]!==null)a[key]=(a[key]??0)+r[key];
    return a;
  },{firstCollections:0,distinctCompleted:0,turns:0,postings:0,inserted:0,duplicates:0,filtered:0,errors:0,completed:0,instrumentedTurns:0,
    listingMs:null,detailMs:null,ingestionMs:null,httpListings:null,httpDetails:null,browserListings:null,browserDetails:null,knownBeforeDetail:null,titleRejectedBeforeDetail:null});
  const hours=(+until-+since)/3600000;
  const result={since:since.toISOString(),until:until.toISOString(),windowMinutes:hours*60,totals,legacyLatestBoardCompletions:legacy,rates:{postingsPerHour:totals.postings/hours,completedBoardsPerHour:totals.completed/hours,insertedPerHour:totals.inserted/hours},sources:rows,note:'Counts only durable completed turns inside the explicit wall-clock window. Old releases lack per-turn completion receipts; their latest-board completion count is separate. Cost and transport fields sum only turns with complete numeric cost instrumentation, counted by instrumentedTurns; null means no instrumented turns, and missing older metrics are unknown. Live windows may have different board mixes.'};
  const json=JSON.stringify(result,null,2)+'\n';if(value('output'))await writeFile(value('output')!,json);process.stdout.write(json);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
