import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const where = {
    status: { in: ['pending_af', 'inbox'] },
    scoringStatus: 'scored',
    afBatchId: null,
    aimFitScore: null,
  };

  const count = await prisma.job.count({ where });
  console.log(`Found ${count} jobs currently in the A/E fit queue.`);

  const result = await prisma.job.updateMany({
    where,
    data: {
      status: 'pending_af', // Make sure they are correctly in the auto-filter state
      scoringStatus: 'queued',
      fitScore: null,
      fitCategory: 'unscored',
      fitRationale: null,
      passReason: null,
      travelScore: null,
      scoreAttempts: 0,
      scoreError: null,
      batchJobId: null, // just in case
    }
  });

  console.log(`Successfully requeued ${result.count} jobs back into the local score queue.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
