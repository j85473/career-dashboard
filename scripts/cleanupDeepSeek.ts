import { prisma } from "../src/lib/prisma";
import { passesPreFilter } from "../src/lib/jobFiltering";

async function main() {
  console.log("Cleaning up DeepSeek queue...");

  const deepseekJobs = await prisma.job.findMany({
    where: { scoringStatus: 'scored', status: { in: ['inbox', 'pending_af'] }, aimFitScore: null },
    select: { id: true, title: true, company: true, description: true, location: true, url: true }
  });
  
  console.log(`Found ${deepseekJobs.length} scored jobs to check.`);
  let archivedCount = 0;
  for (const job of deepseekJobs) {
    const filter = passesPreFilter(job as any);
    if (!filter.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'archived',
          passReason: filter.reason,
          scoringStatus: 'skipped',
          afBatchId: null
        }
      });
      archivedCount++;
    }
  }
  console.log(`Archived ${archivedCount} junk jobs from DeepSeek queue.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
