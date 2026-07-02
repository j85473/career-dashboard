import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: { status: 'pending_af' },
    select: { id: true, description: true, scoringStatus: true }
  });

  let shortJds = 0;
  for (const job of jobs) {
    if (job.description && job.description.length <= 500) {
      shortJds++;
      if (shortJds <= 3) {
        console.log(`Short JD [${job.id}]: length ${job.description.length}, scoringStatus: ${job.scoringStatus}`);
      }
    }
  }
  console.log(`Total pending_af jobs: ${jobs.length}`);
  console.log(`Pending_af jobs with short JDs (<= 500): ${shortJds}`);
}

run().finally(() => prisma.$disconnect());
