import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const job = await prisma.job.findFirst({
    where: { title: 'Inside Sales Rep (Office)' }
  });

  if (job) {
    console.log(`Length: ${job.description?.length}`);
    console.log(`Content: ${JSON.stringify(job.description)}`);
  }
}

run().finally(() => prisma.$disconnect());
