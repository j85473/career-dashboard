import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const startOfDay = new Date('2026-07-15T05:00:00Z'); // 2026-07-15 00:00:00 CDT

  const jobs = await prisma.job.findMany({
    where: {
      updatedAt: { gte: startOfDay },
      status: { in: ['dismissed', 'graveyard'] },
    }
  });

  console.log(`Found ${jobs.length} denied jobs today.`);

  if (jobs.length === 0) {
    console.log('No jobs to resurrect.');
    return;
  }

  const result = await prisma.job.updateMany({
    where: {
      id: { in: jobs.map(j => j.id) }
    },
    data: {
      status: 'pending_af',
      aimFitScore: null,
      jdBatchId: null,
      afBatchId: null,
      batchJobId: null,
      scoringStatus: 'scored',
      deepseekScoreAttempts: 0,
      scoreError: null,
      deepseekScoreError: null,
    }
  });

  console.log(`Successfully resurrected ${result.count} jobs.`);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
