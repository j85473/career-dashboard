import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: { status: 'inbox' }
  });

  let shortCount = 0;
  for (const j of jobs) {
    if (j.description && j.description.length <= 500) {
      shortCount++;
    }
  }

  console.log(`Inbox jobs: ${jobs.length}`);
  console.log(`Inbox jobs with short desc: ${shortCount}`);
}

run().finally(() => prisma.$disconnect());
