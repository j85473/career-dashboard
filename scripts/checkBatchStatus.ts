import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobsWithJdBatchId = await prisma.job.count({
    where: { NOT: { jdBatchId: null } }
  });

  const jobsNeedsJd = await prisma.job.count({
    where: { scoringStatus: 'needs_jd' }
  });

  console.log(`Jobs with jdBatchId: ${jobsWithJdBatchId}`);
  console.log(`Jobs with scoringStatus 'needs_jd': ${jobsNeedsJd}`);
}

run().finally(() => prisma.$disconnect());
