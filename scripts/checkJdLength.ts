import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const job = await prisma.job.findFirst({
    where: { title: { contains: 'Strategic Distributor Sales Pro' } }
  });

  if (job) {
    console.log(`Length: ${job.description?.length}`);
    console.log(`Content: ${job.description}`);
  }
}

run().finally(() => prisma.$disconnect());
