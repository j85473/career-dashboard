import { prisma } from './src/lib/prisma';
async function run() {
  const jobs = await prisma.job.findMany({
    where: { aimFitScore: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: 5
  });
  console.log(`Found ${jobs.length} recently scored jobs.`);
  jobs.forEach(j => console.log(`${j.title}: Aim ${j.aimFitScore}, Exp ${j.reqFitScore}`));
}
run();
