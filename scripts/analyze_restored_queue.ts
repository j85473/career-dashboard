import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
    },
    select: {
      title: true,
      company: true,
    }
  });

  console.log(`Total jobs in queue: ${jobs.length}`);

  const titleCounts: Record<string, number> = {};
  const companyCounts: Record<string, number> = {};

  for (const job of jobs) {
    const title = job.title || 'Unknown';
    const company = job.company || 'Unknown';
    
    titleCounts[title] = (titleCounts[title] || 0) + 1;
    companyCounts[company] = (companyCounts[company] || 0) + 1;
  }

  const sortedTitles = Object.entries(titleCounts).sort((a, b) => b[1] - a[1]);
  const sortedCompanies = Object.entries(companyCounts).sort((a, b) => b[1] - a[1]);

  console.log('\nTop 20 job titles in the queue:');
  for (let i = 0; i < 20 && i < sortedTitles.length; i++) {
    console.log(`${sortedTitles[i][0]}: ${sortedTitles[i][1]} jobs`);
  }

  console.log('\nTop 10 companies:');
  for (let i = 0; i < 10 && i < sortedCompanies.length; i++) {
    console.log(`${sortedCompanies[i][0]}: ${sortedCompanies[i][1]} jobs`);
  }

  // Look for "sales" jobs
  let salesCount = 0;
  for (const job of jobs) {
    if (job.title?.toLowerCase().includes('sales')) {
      salesCount++;
    }
  }
  console.log(`\nJobs with "sales" in the title: ${salesCount}`);

  await prisma.$disconnect();
}

main().catch(console.error);
