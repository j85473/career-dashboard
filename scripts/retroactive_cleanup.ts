import { PrismaClient } from '@prisma/client';
import { passesPreFilter } from '../src/lib/jobFiltering';
import { findLikelyDuplicateJob } from '../src/lib/jobIngestion';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting retroactive cleanup of pending DeepSeek jobs...');

  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'scored',
      afBatchId: null,
      aimFitScore: null,
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      url: true,
      canonicalUrl: true,
      source: true,
      sourceId: true,
    }
  });

  console.log(`Found ${jobs.length} jobs to evaluate.`);

  let archivedPreFilter = 0;
  let archivedDuplicate = 0;
  let skippedEmptyDesc = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    if (i % 100 === 0) {
      console.log(`Processing job ${i + 1} of ${jobs.length}...`);
    }

    if (!job.description) {
      skippedEmptyDesc++;
      continue;
    }

    // 1. Run Pre-filters
    const filter = passesPreFilter({
      title: job.title || '',
      company: job.company || '',
      description: job.description,
      location: job.location || '',
      url: job.url || ''
    });

    if (!filter.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'archived',
          scoringStatus: 'skipped',
          passReason: `Retroactive filter: ${filter.reason}`
        }
      });
      archivedPreFilter++;
      continue;
    }

    // 2. Run Deduplication
    const duplicate = await findLikelyDuplicateJob({
      title: job.title || '',
      company: job.company || '',
      description: job.description,
      location: job.location || '',
      url: job.url || '',
      canonicalUrl: job.canonicalUrl || job.url || '',
      source: job.source || '',
      sourceId: job.sourceId || ''
    });

    if (duplicate && duplicate.id !== job.id) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'archived',
          scoringStatus: 'skipped',
          passReason: 'Retroactive filter: Duplicate description found after JD extraction'
        }
      });
      archivedDuplicate++;
      continue;
    }
  }

  console.log('--- Cleanup Summary ---');
  console.log(`Total jobs evaluated: ${jobs.length}`);
  console.log(`Archived by pre-filters: ${archivedPreFilter}`);
  console.log(`Archived as duplicates: ${archivedDuplicate}`);
  console.log(`Skipped (empty description): ${skippedEmptyDesc}`);
  console.log(`Remaining jobs waiting for DeepSeek: ${jobs.length - archivedPreFilter - archivedDuplicate}`);

  await prisma.$disconnect();
}

main().catch(console.error);
