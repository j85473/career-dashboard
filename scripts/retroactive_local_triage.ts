import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      fitScore: { not: null }
    }
  });

  console.log(`Found ${jobs.length} active jobs with a fitScore. Analyzing...`);
  
  let dismissedCount = 0;

  for (const job of jobs) {
    let deterministicallyRejected = false;
    let passReason = null;
    
    if (job.fitScore !== null) {
      if (job.fitScore < 70) {
        deterministicallyRejected = true;
        passReason = '[Local Triage] Fit score too low.';
      } else if (job.postedAt) {
        const daysOld = (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysOld > 20 && job.fitScore < 90) {
          deterministicallyRejected = true;
          passReason = '[Local Triage] Job too old and fit score under 90.';
        }
      }
    }

    if (deterministicallyRejected) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'dismissed',
          luckyStatus: 'none',
          passReason: passReason,
          scoringStatus: 'skipped'
        }
      });
      dismissedCount++;
    }
  }

  console.log(`Finished. Dismissed ${dismissedCount} jobs based on new Local Triage criteria.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
