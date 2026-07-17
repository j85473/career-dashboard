import { PrismaClient } from '@prisma/client';
import { scoreJobs } from '../src/lib/jobScoring';

const prisma = new PrismaClient();

async function main() {
  console.log('Running local scoring engine on all queued jobs...');
  let totalScored = 0;
  while (true) {
    const scoredCount = await scoreJobs(undefined, undefined, { limit: 500 });
    if (scoredCount === 0) break;
    totalScored += scoredCount;
    console.log(`Scored ${totalScored} jobs so far...`);
  }
  console.log(`Finished scoring. Total newly scored jobs: ${totalScored}`);

  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      fitScore: { not: null }
    },
    select: { fitScore: true }
  });

  let scoreAtLeast50 = 0;
  let scoreAtLeast60 = 0;
  let scoreAtLeast70 = 0;

  for (const job of jobs) {
    const score = job.fitScore || 0;
    if (score >= 50) scoreAtLeast50++;
    if (score >= 60) scoreAtLeast60++;
    if (score >= 70) scoreAtLeast70++;
  }

  console.log('\n--- Simulation Results ---');
  console.log(`Total scored jobs in queue: ${jobs.length}`);
  console.log(`Jobs with score >= 50: ${scoreAtLeast50}`);
  console.log(`Jobs with score >= 60: ${scoreAtLeast60}`);
  console.log(`Jobs with score >= 70: ${scoreAtLeast70}`);

  await prisma.$disconnect();
}

main().catch(console.error);
