import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Fetching jobs in inbox...");
  
  const jobs = await prisma.job.findMany({
    where: {
      status: 'inbox',
      tailoringStaged: false,
      fitScore: { not: null },
      aimFitScore: { not: null }
    },
    orderBy: [
      { fitScore: 'desc' },
      { aimFitScore: 'desc' },
      { travelScore: 'desc' }
    ],
    take: 13
  });

  if (jobs.length === 0) {
    console.log("No jobs found in inbox that match the criteria!");
    return;
  }

  console.log(`Found ${jobs.length} jobs to stage.`);
  
  for (const job of jobs) {
    console.log(`- [Fit:${job.fitScore}/Aim:${job.aimFitScore}] ${job.title} at ${job.company}`);
    await prisma.job.update({
      where: { id: job.id },
      data: { tailoringStaged: true }
    });
  }

  console.log("Staging complete!");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
