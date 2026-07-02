import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.findMany({
    where: { 
      status: 'pending_af'
    },
    take: 5
  });

  console.log("Jobs currently in pending_af:", jobs.length);
  
  const processingAf = await prisma.job.count({
    where: { status: 'pending_af', afBatchId: 'processing' }
  });
  console.log("Jobs with afBatchId = processing:", processingAf);

  const missingAf = await prisma.job.count({
    where: { status: 'pending_af', afBatchId: null, scoringStatus: 'scored' }
  });
  console.log("Jobs ready for AF (pending_af + scored + afBatchId: null):", missingAf);
}

run().finally(() => prisma.$disconnect());
