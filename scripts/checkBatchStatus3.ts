import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.groupBy({
    by: ['jdBatchId'],
    where: { NOT: { jdBatchId: null } },
    _count: { jdBatchId: true }
  });

  console.log("Jobs with jdBatchId:");
  console.log(jobs);
}

run().finally(() => prisma.$disconnect());
