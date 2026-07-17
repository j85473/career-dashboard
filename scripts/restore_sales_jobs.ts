import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'dismissed',
      passReason: 'Sales & Marketing role rejected'
    }
  });

  console.log(`Found ${jobs.length} wrongly dismissed sales jobs.`);
  
  let restored = 0;
  for (const job of jobs) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'inbox',
        scoringStatus: 'queued',
        passReason: null
      }
    });
    restored++;
  }

  console.log(`Restored ${restored} wrongly dismissed sales jobs back to inbox/queued.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
