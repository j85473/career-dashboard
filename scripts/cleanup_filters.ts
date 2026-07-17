import { PrismaClient } from '@prisma/client';
import { passesPreFilter } from '../src/lib/jobFiltering';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['inbox', 'pending_af'] }
    }
  });

  console.log(`Analyzing ${jobs.length} jobs in queue...`);
  
  let dismissedCount = 0;
  let reasonCounts: Record<string, number> = {};

  for (const job of jobs) {
    const result = passesPreFilter({
      title: job.title,
      company: job.company,
      description: job.description || '',
      location: job.location || '',
      url: job.url || ''
    });

    if (!result.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'dismissed',
          scoringStatus: 'skipped',
          passReason: result.reason
        }
      });
      dismissedCount++;
      reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
    }
  }

  console.log(`\nCleanup Complete! Dismissed ${dismissedCount} jobs.`);
  console.log('Breakdown of reasons:');
  for (const [reason, count] of Object.entries(reasonCounts)) {
    console.log(`- ${reason}: ${count}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
