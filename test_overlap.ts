import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const overlap = await prisma.job.count({
    where: { status: 'inbox', luckyStatus: 'inbox' }
  });
  console.log("Overlap count:", overlap);
  
  const justInbox = await prisma.job.count({
    where: { status: 'inbox' }
  });
  console.log("Total status: inbox:", justInbox);
  
  const actualInboxTab = await prisma.job.count({
    where: {
      status: 'inbox',
      tailoringStaged: false,
      luckyStatus: { not: 'inbox' },
      aimFitScore: { not: null },
    }
  });
  console.log("Actual Inbox Tab Count:", actualInboxTab);
}
main().catch(console.error).finally(() => prisma.$disconnect());
