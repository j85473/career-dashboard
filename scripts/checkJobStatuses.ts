import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const recentJobs = await prisma.job.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  for (const job of recentJobs) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Desc Length: ${job.description?.length}`);
    console.log(`Scoring Status: ${job.scoringStatus}`);
    console.log(`Experience Status: ${job.experienceStatus}`);
    console.log(`Score Attempts: ${job.scoreAttempts}`);
    console.log('---');
  }
}

run().finally(() => prisma.$disconnect());
