import { prisma } from '../src/lib/prisma';
import { passesPreFilter } from '../src/lib/jobFiltering';

async function main() {
  // Fetch all jobs currently pending evaluation
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['inbox', 'pending_af'] },
      aimFitScore: null,
    },
  });

  console.log(`Found ${jobs.length} jobs pending evaluation.`);

  let rejectedCount = 0;
  for (const job of jobs) {
    const filterResult = passesPreFilter({
      title: job.title,
      company: job.company,
      description: job.description || '',
      location: job.location || '',
      url: job.url || ''
    });

    if (!filterResult.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'dismissed',
          scoringStatus: 'skipped',
          passReason: filterResult.reason,
        }
      });
      rejectedCount++;
      console.log(`Rejected ${job.title} at ${job.company}: ${filterResult.reason}`);
    }
  }

  console.log(`Finished processing. Rejected ${rejectedCount} junk jobs.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
