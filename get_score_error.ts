import { prisma } from './src/lib/prisma';
async function run() {
  const jobs = await prisma.job.findMany({
    where: { scoreError: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: 1
  });
  console.log(jobs[0]?.scoreError);
}
run();
