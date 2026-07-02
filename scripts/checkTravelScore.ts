import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: { 
      status: 'inbox',
      travelScore: null
    }
  });

  console.log(`Jobs in inbox with travelScore = null: ${jobs.length}`);
}

run().finally(() => prisma.$disconnect());
