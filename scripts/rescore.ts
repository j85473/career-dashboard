import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("Starting DB reset for rescoring...");

  // 1. Rescore all Inbox jobs (standard A/E fit)
  const inboxUpdated = await prisma.job.updateMany({
    where: { status: 'inbox' },
    data: { aimFitScore: null, reqFitScore: null, fitScore: null, fitRationale: null }
  });
  console.log(`Reset ${inboxUpdated.count} standard inbox jobs for rescoring.`);

  // 2. Rescore all I'm Feeling Lucky jobs (both inbox and dismissed)
  const luckyUpdated = await prisma.job.updateMany({
    where: { luckyStatus: { in: ['inbox', 'dismissed'] } },
    data: { luckyStatus: 'pending', luckyAimFitScore: null, luckyPassReason: null }
  });
  console.log(`Reset ${luckyUpdated.count} wildcard jobs for rescoring.`);

  // 3. Rescore last 7 days of dismissed jobs (standard)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const dismissedUpdated = await prisma.job.updateMany({
    where: { 
      status: 'dismissed',
      updatedAt: { gte: sevenDaysAgo }
    },
    data: { status: 'inbox', aimFitScore: null, reqFitScore: null, fitScore: null, fitRationale: null }
  });
  console.log(`Restored ${dismissedUpdated.count} dismissed jobs from the last week for rescoring.`);
  
  console.log("Done. The background pipeline will gradually pick these up.");
}
main().catch(console.error).finally(() => prisma.$disconnect());
