/** Receipt-backed, read-only throughput window. Never claims work or launches a browser. */
import { writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { Prisma } from '../src/lib/prismaClient';
import { NON_API_ATS_PLATFORMS } from '../src/lib/browserAtsBoards';
async function main() {
  const args=process.argv.slice(2);
  if(args.some(a=>!/^--(?:since|until|output)=.+$/.test(a))) throw Error('Usage: benchmark_ats_crawling.ts --since=ISO --until=ISO [--output=file]');
  const value=(name:string)=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  const since=new Date(value('since')||''),until=new Date(value('until')||'');
  if(!Number.isFinite(+since)||!Number.isFinite(+until)||+until<=+since)throw Error('Supply a positive, explicit UTC benchmark window');
  const sources=NON_API_ATS_PLATFORMS.map(p=>p==='gusto'?'Gusto':`ATS-${p}`);
  const rows=await prisma.$queryRaw<Array<{source:string;turns:number;postings:number;inserted:number;duplicates:number;filtered:number;errors:number;completed:number;seconds:number}>>(Prisma.sql`
    SELECT source,count(*)::int AS turns,COALESCE(sum("seenCount"),0)::int AS postings,
      COALESCE(sum("insertedCount"),0)::int AS inserted,COALESCE(sum("duplicateCount"),0)::int AS duplicates,
      COALESCE(sum("filteredCount"),0)::int AS filtered,count(*) FILTER(WHERE "requestErrorCount">0 OR "processingErrorCount">0)::int AS errors,
      COALESCE(sum(CASE WHEN checkpoint->'crawl'->>'complete'='true' THEN 1 ELSE 0 END+COALESCE((checkpoint->'crawl'->>'completedBoards')::int,0)),0)::int AS completed,
      COALESCE(sum("durationMs"),0)::float8/1000 AS seconds
    FROM "IngestionSourceRun" WHERE source IN (${Prisma.join(sources)}) AND "ingestionMode"='public-board'
      AND "createdAt">=(${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND "startedAt">=(${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND "finishedAt"<=(${until.toISOString()}::timestamptz AT TIME ZONE 'UTC') GROUP BY source ORDER BY source
  `);
  const legacy=await prisma.atsCompany.count({where:{platform:{in:[...NON_API_ATS_PLATFORMS]},lastSynchronizedAt:{gte:since,lte:until}}});
  const totals=rows.reduce((a,r)=>({turns:a.turns+r.turns,postings:a.postings+r.postings,inserted:a.inserted+r.inserted,duplicates:a.duplicates+r.duplicates,filtered:a.filtered+r.filtered,errors:a.errors+r.errors,completed:a.completed+r.completed}),{turns:0,postings:0,inserted:0,duplicates:0,filtered:0,errors:0,completed:0});
  const hours=(+until-+since)/3600000;
  const result={since:since.toISOString(),until:until.toISOString(),windowMinutes:hours*60,totals,legacyLatestBoardCompletions:legacy,rates:{postingsPerHour:totals.postings/hours,completedBoardsPerHour:totals.completed/hours,insertedPerHour:totals.inserted/hours},sources:rows,note:'Counts only durable completed turns inside the explicit wall-clock window. Old releases lack per-turn completion receipts; their latest-board completion count is separate. Live windows may have different board mixes.'};
  const json=JSON.stringify(result,null,2)+'\n';if(value('output'))await writeFile(value('output')!,json);process.stdout.write(json);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
