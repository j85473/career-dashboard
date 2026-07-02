import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const inboxJobs = await prisma.job.findMany({
    where: { status: 'inbox' }
  });

  let queuedForExperience = 0;
  let pushedToNeedsJd = 0;

  for (const job of inboxJobs) {
    const desc = job.description || '';
    const isTruncated = desc.endsWith('...') || desc.endsWith('…') || desc.length <= 500;

    if (isTruncated) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          scoringStatus: 'needs_jd',
          experienceStatus: 'unscored',
          batchJobId: null
        }
      });
      pushedToNeedsJd++;
    } else {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          experienceStatus: 'queued',
          batchJobId: null
        }
      });
      queuedForExperience++;
    }
  }

  console.log(`Successfully queued ${queuedForExperience} jobs directly for Experience Scoring.`);
  console.log(`Pushed ${pushedToNeedsJd} jobs to Needs JD Search queue.`);
}

run()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
