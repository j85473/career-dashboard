const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const byHour = await prisma.$queryRaw`
    SELECT date_trunc('hour', "updatedAt") as hr, count(*) as cnt
    FROM "Job"
    GROUP BY date_trunc('hour', "updatedAt")
    ORDER BY hr DESC
    LIMIT 24
  `;
  
  console.log("Job updates by hour in DB:");
  console.table(byHour);
}

main().catch(console.error).finally(() => prisma.$disconnect());
