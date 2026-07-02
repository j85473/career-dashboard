import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'inbox'
    }
  });

  let backfilled = 0;

  for (const job of jobs) {
    const desc = job.description || '';
    if (desc.length <= 500) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'pending_af',
          scoringStatus: 'needs_jd',
          jdBatchId: null, // Clear this out in case it's stuck
          scoreAttempts: 0
        }
      });
      backfilled++;
    }
  }

  console.log(`Backfilled ${backfilled} truncated jobs from inbox to pending_af.`);
}

run().finally(() => prisma.$disconnect());
