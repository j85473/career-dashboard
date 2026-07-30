import { PrismaClient } from '@prisma/client';
import { scoreJobs } from '../src/lib/jobScoring';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scored',
      status: { in: ['pending_af', 'inbox'] }
    },
    data: {
      scoringStatus: 'queued',
      batchJobId: null,
      jdBatchId: null
    }
  });

  console.log(`Re-queued ${result.count} jobs for local scoring.`);

  console.log('Running local scoring...');
  let totalScored = 0;
  for (let localPass = 0; localPass < 50; localPass++) {
    const processed = await scoreJobs((msg) => {
      if (!msg.startsWith('No new jobs') && !msg.startsWith('No resumes')) {
        totalScored++;
        if (totalScored % 100 === 0) {
            console.log(`...processed ${totalScored} jobs`);
        }
      }
    });
    if (processed === 0) break;
  }
  
  console.log(`Finished local scoring. Total processed: ${totalScored}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
