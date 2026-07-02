import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jobs = await prisma.job.groupBy({
    by: ['status'],
    where: { 
      jdBatchId: null, // Since we unstuck them, they are null now!
      scoringStatus: 'scored' 
    },
    _count: { id: true }
  });

  console.log("Status of unstuck 'scored' jobs:");
  console.log(jobs);
}

run().finally(() => prisma.$disconnect());
