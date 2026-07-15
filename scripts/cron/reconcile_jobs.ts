import './env';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Starting job reconciliation...");

  // Reset jobs stuck in local scoring
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
  const stuckActiveScoring = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scoring',
      status: { in: ['pending_af', 'inbox'] },
      updatedAt: { lt: thirtyMinsAgo }
    },
    data: {
      scoringStatus: 'queued',
      jdBatchId: null,
      batchJobId: null,
    }
  });
  const stuckInactiveScoring = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scoring',
      status: { notIn: ['pending_af', 'inbox'] },
      updatedAt: { lt: thirtyMinsAgo }
    },
    data: {
      scoringStatus: 'scored',
      jdBatchId: null,
      batchJobId: null,
    }
  });
  console.log(`Released ${stuckActiveScoring.count + stuckInactiveScoring.count} jobs stuck in local scoring (${stuckActiveScoring.count} requeued, ${stuckInactiveScoring.count} inactive).`);

  // Reset jobs stuck in JD Batch claiming
  const sixtyMinsAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stuckJDBatchClaiming = await prisma.job.updateMany({
    where: {
      jdBatchId: { startsWith: 'run-' },
      updatedAt: { lt: sixtyMinsAgo }
    },
    data: {
      jdBatchId: null
    }
  });
  console.log(`Reset ${stuckJDBatchClaiming.count} jobs stuck in JD Batch claiming.`);

  // Reset jobs stuck in Experience Scoring (Aim Fit)
  const stuckExperienceScoring = await prisma.job.updateMany({
    where: {
      experienceStatus: 'scoring',
      updatedAt: { lt: thirtyMinsAgo }
    },
    data: {
      experienceStatus: 'queued',
      afBatchId: null
    }
  });
  console.log(`Reset ${stuckExperienceScoring.count} jobs stuck in Experience Scoring (experienceStatus = 'scoring').`);

  // Reset jobs stuck in AF Batch claiming or manual
  const stuckAFBatchClaiming = await prisma.job.updateMany({
    where: {
      OR: [
        { afBatchId: 'processing' },
        { afBatchId: 'MANUAL' }
      ],
      updatedAt: { lt: thirtyMinsAgo }
    },
    data: {
      afBatchId: null
    }
  });
  console.log(`Reset ${stuckAFBatchClaiming.count} jobs stuck in AF Batch claiming or MANUAL.`);

  const staleDeepseek = await prisma.job.updateMany({
    where: {
      afBatchId: { startsWith: 'deepseek:' },
      aimFitScore: null,
      updatedAt: { lt: thirtyMinsAgo },
    },
    data: { afBatchId: null },
  });
  console.log(`Released ${staleDeepseek.count} stale standard DeepSeek leases.`);

  const staleLuckyDismissed = await prisma.job.updateMany({
    where: {
      luckyBatchId: { startsWith: 'deepseek-lucky:' },
      luckyStatus: 'scoring',
      status: 'dismissed',
      updatedAt: { lt: thirtyMinsAgo },
    },
    data: { luckyBatchId: null, luckyStatus: 'pending' },
  });
  const staleLuckyInactive = await prisma.job.updateMany({
    where: {
      luckyBatchId: { startsWith: 'deepseek-lucky:' },
      luckyStatus: 'scoring',
      status: { not: 'dismissed' },
      updatedAt: { lt: thirtyMinsAgo },
    },
    data: { luckyBatchId: null, luckyStatus: 'none' },
  });
  console.log(`Released ${staleLuckyDismissed.count + staleLuckyInactive.count} stale wildcard DeepSeek leases.`);
  
  // Archive old jobs (migrated from client-side Dashboard.tsx)
  const twentyFiveDaysAgo = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
  
  const archived = await prisma.job.updateMany({
    where: {
      createdAt: { lt: twentyFiveDaysAgo },
      status: { notIn: ['archived', 'applied', 'interviewing', 'passed', 'bookmarked'] },
      tailoringStaged: { not: true }
    },
    data: {
      status: 'archived'
    }
  });
  console.log(`Archived ${archived.count} old jobs.`);

  console.log("Reconciliation complete.");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
