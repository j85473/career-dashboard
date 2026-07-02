import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  // Let's sweep through the inbox/applied/bookmarked jobs again
  // Actually, we can just look at anything in experience queue
  const jobs = await prisma.job.findMany({
    where: {
      experienceStatus: { in: ['queued', 'processing'] }
    }
  });

  let pushedToNeedsJd = 0;

  for (const job of jobs) {
    const desc = job.description || '';
    const isTruncated = desc.endsWith('...') || desc.endsWith('…') || desc.length <= 1000;

    if (isTruncated) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          scoringStatus: 'needs_jd',
          experienceStatus: 'needs_jd',
          batchJobId: null
        }
      });
      pushedToNeedsJd++;
    }
  }

  console.log(`Pushed ${pushedToNeedsJd} more jobs from experience queue back to Needs JD Search queue (new threshold: 1000).`);
}

run().finally(() => prisma.$disconnect());
