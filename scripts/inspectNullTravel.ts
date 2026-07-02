import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: { 
      status: 'inbox',
      travelScore: null
    },
    take: 3
  });

  console.log(JSON.stringify(jobs, null, 2));
}

run().finally(() => prisma.$disconnect());
