import { prisma } from './src/lib/prisma';
import { identifyAts } from './src/lib/atsUtils';
import { jobWhere } from './src/lib/jobListQuery';

async function main() {
  const inboxJobs = await prisma.job.findMany({
    where: jobWhere('inbox', ''),
    select: { id: true, url: true, source: true, manualAts: true, company: true, title: true }
  });

  const targetAts = ['Ashby', 'Lever', 'Greenhouse'];
  let stagedCount = 0;
  let skippedDuplicates = 0;

  for (const job of inboxJobs) {
    const ats = identifyAts(job);
    if (targetAts.includes(ats)) {
      // Check if we already have a job staged for this company
      const existingStagedJob = await prisma.job.findFirst({
        where: {
          company: job.company,
          tailoringStaged: true,
        },
        select: { id: true }
      });

      if (existingStagedJob) {
        skippedDuplicates++;
        console.log(`Skipped ${job.company} - ${job.title} (already has a staged job)`);
      } else {
        await prisma.job.update({
          where: { id: job.id },
          data: { tailoringStaged: true }
        });
        stagedCount++;
        console.log(`Staged ${job.company} - ${job.title}`);
      }
    }
  }

  console.log(`\nDone! Staged ${stagedCount} jobs. Skipped ${skippedDuplicates} due to same-company constraint.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
