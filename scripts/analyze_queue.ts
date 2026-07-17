import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'scored',
      afBatchId: null,
      aimFitScore: null,
    },
    select: {
      title: true,
      company: true,
    }
  });

  const unique = new Set();
  let exactDupes = 0;
  for (const job of jobs) {
    const key = `${job.company?.toLowerCase()}|${job.title?.toLowerCase()}`;
    if (unique.has(key)) {
      exactDupes++;
    } else {
      unique.add(key);
    }
  }

  console.log(`Total jobs: ${jobs.length}`);
  console.log(`Unique company|title pairs: ${unique.size}`);
  console.log(`Exact dupes by company|title: ${exactDupes}`);

  // Print top 10 companies by job count
  const companyCounts: Record<string, number> = {};
  for (const job of jobs) {
    const company = job.company || 'Unknown';
    companyCounts[company] = (companyCounts[company] || 0) + 1;
  }
  const sortedCompanies = Object.entries(companyCounts).sort((a, b) => b[1] - a[1]);
  console.log('\nTop 10 companies:');
  for (let i = 0; i < 10 && i < sortedCompanies.length; i++) {
    console.log(`${sortedCompanies[i][0]}: ${sortedCompanies[i][1]} jobs`);
  }

  // Print some examples of jobs
  console.log('\nSample jobs:');
  for (let i = 0; i < 10 && i < jobs.length; i++) {
    console.log(`- ${jobs[i].company}: ${jobs[i].title}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
