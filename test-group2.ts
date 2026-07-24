import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const ingest = await prisma.$queryRaw`
    SELECT 
      DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
      SUM("insertedCount") as inserted,
      SUM("filteredCount") as filtered
    FROM "IngestionSourceRun"
    GROUP BY DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
    ORDER BY date DESC
    LIMIT 14;
  `;
  console.log(ingest);
}
main().finally(() => prisma.$disconnect());
