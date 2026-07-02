import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const count = await prisma.job.updateMany({
    where: { jdBatchId: 'processing' },
    data: { jdBatchId: null }
  });
  console.log(`Unstuck ${count.count} jobs with jdBatchId = processing`);
}

run().finally(() => prisma.$disconnect());
