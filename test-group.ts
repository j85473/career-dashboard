import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.$queryRaw`
    SELECT 
      DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
      COUNT(*) as count
    FROM "Job"
    GROUP BY DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
    ORDER BY date DESC
    LIMIT 5;
  `;
  console.log(jobs);
}
main().finally(() => prisma.$disconnect());
