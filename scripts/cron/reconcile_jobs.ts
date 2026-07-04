import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Starting job reconciliation...");

  // Reset jobs stuck in local scoring
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
  const stuckScoring = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scoring',
      updatedAt: { lt: thirtyMinsAgo }
    },
    data: {
      scoringStatus: 'queued',
      jdBatchId: null
    }
  });
  console.log(`Reset ${stuckScoring.count} jobs stuck in local scoring (scoringStatus = 'scoring').`);

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
  
  // Archive old jobs (migrated from client-side Dashboard.tsx)
  const twentyFiveDaysAgo = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
  
  const archived = await prisma.job.updateMany({
    where: {
      createdAt: { lt: twentyFiveDaysAgo },
      status: { notIn: ['archived', 'applied', 'passed', 'bookmarked'] },
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
