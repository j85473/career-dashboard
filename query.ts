import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      aimFitScore: { not: null },
      reqFitScore: { not: null }
    },
    take: 5,
    orderBy: { createdAt: 'desc' }
  });
  console.log("Jobs with reqFitScore:", jobs.length);

  const events = await prisma.jobScoreEvent.findMany({
    where: {
      aimFitScore: { not: null },
      experienceFitScore: { not: null }
    },
    take: 5,
    orderBy: { createdAt: 'desc' }
  });
  console.log("JobScoreEvents:", events.length);
}

main().then(() => prisma.$disconnect());
