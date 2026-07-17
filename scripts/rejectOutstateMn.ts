import { PrismaClient } from '@prisma/client';
import { passesPreFilter } from '../src/lib/jobFiltering';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching active jobs...');
  // We only care about jobs that are not already Failed/Rejected
  const jobs = await prisma.job.findMany({
    where: {
      status: {
        notIn: ['Failed', 'Rejected']
      }
    }
  });

  console.log(`Found ${jobs.length} jobs to check.`);

  let rejectedCount = 0;
  for (const job of jobs) {
    // Only test the location explicitly based on our new logic, or we can just pass it to passesPreFilter
    // The instructions say: "Write a brief script to retroactively scan the database and reject jobs that match the new outstate Minnesota rule, marking their status as "failed"."
    // Let's do it directly since we know the new logic.

    if (job.location) {
      const exactLocLower = job.location.toLowerCase();
      const outstateMn = /\b(rochester|duluth|st\.?\s*cloud|saint\s*cloud|mankato|moorhead|bemidji|brainerd)\b/;
      if (outstateMn.test(exactLocLower)) {
        console.log(`Rejecting job ID: ${job.id} | Title: "${job.title}" | Location: "${job.location}"`);
        
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'Failed',
            passReason: 'Outstate MN location rejected'
          }
        });
        rejectedCount++;
      }
    }
  }

  console.log(`\nFinished! Rejected ${rejectedCount} jobs.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
