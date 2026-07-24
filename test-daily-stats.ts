import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const today = new Date();
  today.setHours(0,0,0,0);
  
  const jobsIngested = await prisma.job.count({ where: { createdAt: { gte: today } } });
  
  const ingestRuns = await prisma.ingestionSourceRun.aggregate({
    where: { startedAt: { gte: today } },
    _sum: { filteredCount: true, insertedCount: true, seenCount: true }
  });

  const jobsByStatus = await prisma.job.groupBy({
    by: ['status'],
    where: { createdAt: { gte: today } },
    _count: true
  });
  
  const luckyJobs = await prisma.job.count({
    where: { luckyStatus: 'inbox', createdAt: { gte: today } }
  });
  
  const scoreEvents = await prisma.jobScoreEvent.groupBy({
    by: ['passed'],
    where: { createdAt: { gte: today } },
    _count: true
  });

  console.log("jobsIngested:", jobsIngested);
  console.log("ingestRuns:", ingestRuns);
  console.log("jobsByStatus:", jobsByStatus);
  console.log("luckyJobs:", luckyJobs);
  console.log("scoreEvents:", scoreEvents);
}
main().finally(() => prisma.$disconnect());
