import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const [ingest, jobs, scores] = await Promise.all([
    prisma.$queryRaw`
      SELECT 
        DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
        SUM("insertedCount") as ingested,
        SUM("filteredCount") as "killedLocal"
      FROM "IngestionSourceRun"
      GROUP BY DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
      ORDER BY date DESC
      LIMIT 14;
    ` as Promise<any[]>,
    prisma.$queryRaw`
      SELECT 
        DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
        SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) as inbox,
        SUM(CASE WHEN "luckyStatus" = 'inbox' THEN 1 ELSE 0 END) as lucky
      FROM "Job"
      GROUP BY DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
      ORDER BY date DESC
      LIMIT 14;
    ` as Promise<any[]>,
    prisma.$queryRaw`
      SELECT 
        DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
        SUM(CASE WHEN passed = false THEN 1 ELSE 0 END) as "killedAE",
        SUM(CASE WHEN passed = true THEN 1 ELSE 0 END) as "passedAE"
      FROM "JobScoreEvent"
      GROUP BY DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
      ORDER BY date DESC
      LIMIT 14;
    ` as Promise<any[]>
  ]);

  const map = new Map();
  const add = (arr: any[]) => {
    arr.forEach(row => {
      if (!row.date) return;
      // Convert date object to YYYY-MM-DD
      const dateStr = row.date.toISOString().split('T')[0];
      const existing = map.get(dateStr) || { date: dateStr, ingested: 0, killedLocal: 0, killedAE: 0, passedAE: 0, inbox: 0, lucky: 0 };
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'date') existing[k] = Number(v) || 0;
      }
      map.set(dateStr, existing);
    });
  };
  add(ingest); add(jobs); add(scores);

  const final = Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  console.log(final.slice(0, 5));
}
main().finally(() => prisma.$disconnect());
