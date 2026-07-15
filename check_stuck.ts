import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'pending_af',
      scoringStatus: 'scored'
    },
    select: {
      id: true,
      company: true,
      title: true,
      status: true,
      scoringStatus: true,
      afBatchId: true,
      aimFitScore: true,
      scoreError: true,
      scoreAttempts: true,
      description: true
    }
  });
  console.log(JSON.stringify(jobs.map(j => ({...j, description: j.description ? 'present' : 'missing'})), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
