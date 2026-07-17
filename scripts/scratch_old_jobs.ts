import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const date = new Date();
  date.setDate(date.getDate() - 20);

  const oldJobs = await prisma.job.count({
    where: { 
      status: { in: ['pending_af', 'inbox'] }, 
      fitScore: { gte: 70 }, 
      postedAt: { lt: date } 
    }
  });

  console.log(`Jobs over 20 days old: ${oldJobs}`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
