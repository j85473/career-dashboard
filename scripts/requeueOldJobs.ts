import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scored',
      recommendedResume: null,
      fitCategory: { not: 'unscored' }
    },
    data: {
      scoringStatus: 'queued',
      scoreAttempts: 0,
      scoreError: null
    }
  });

  console.log(`Re-queued ${result.count} old jobs for batch scoring.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
