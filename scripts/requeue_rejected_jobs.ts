import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
  
  const tenDaysAgoISO = tenDaysAgo.toISOString();

  console.log(`Requeuing jobs rejected after ${tenDaysAgoISO}...`);

  const res = await prisma.$executeRawUnsafe(`
    UPDATE "Job"
    SET "status" = 'pending_af',
        "scoringStatus" = 'queued',
        "aimFitScore" = NULL,
        "reqFitScore" = NULL,
        "afBatchId" = NULL,
        "scoreAttempts" = 0
    WHERE "status" = 'dismissed'
      AND "aimFitScore" IS NOT NULL
      AND "updatedAt" >= '${tenDaysAgoISO}'
  `);

  console.log(`Re-queued ${res} historically rejected jobs.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
