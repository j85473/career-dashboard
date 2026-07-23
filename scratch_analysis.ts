import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const events = await prisma.jobScoreEvent.findMany({
    where: { passed: false },
    orderBy: { createdAt: 'desc' },
    take: 500
  });

  const jobIds = events.map(e => e.jobId);
  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } } });
  const jobsMap = new Map();
  jobs.forEach(j => jobsMap.set(j.id, j));

  const rejectedJobs = events.map(e => {
    const j = jobsMap.get(e.jobId);
    return j ? { title: j.title, company: j.company, reason: e.aimReason, experienceReason: e.experienceReason } : null;
  }).filter(j => j !== null);

  const printSample = (companyMatch: string) => {
    console.log(`\n=== SAMPLE FOR ${companyMatch.toUpperCase()} ===`);
    const subset = rejectedJobs.filter(j => j!.company.toLowerCase().includes(companyMatch));
    console.log(JSON.stringify(subset.slice(0, 3), null, 2));
  };

  printSample('equipmentshare');
  printSample('thomson reuters');
  printSample('ey');
  printSample('doordash');
  printSample('wells fargo');
  printSample('fivetran');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
