import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function unstickJobs() {
  console.log('Unsticking jobs trapped in needs_jd and queued statuses...');
  
  // 1. Unstick jobs trapped in needs_jd
  const unstickNeedsJd = await prisma.job.updateMany({
    where: {
      scoringStatus: 'needs_jd',
      status: { in: ['pending_af', 'inbox'] },
      scoreAttempts: { gte: 3 }
    },
    data: {
      scoreAttempts: 0,
      jdBatchId: null,
      scoreError: null
    }
  });
  console.log(`Unstuck ${unstickNeedsJd.count} jobs in needs_jd by resetting scoreAttempts.`);

  // 2. Unstick jobs trapped in queued
  const unstickQueued = await prisma.job.updateMany({
    where: {
      scoringStatus: 'queued',
      status: { in: ['pending_af', 'inbox'] },
      scoreAttempts: { gte: 3 }
    },
    data: {
      scoreAttempts: 0,
      batchJobId: null,
      scoreError: null
    }
  });
  console.log(`Unstuck ${unstickQueued.count} jobs in queued by resetting scoreAttempts.`);

  // 3. Clear any orphaned leases that might be older than 15 minutes
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  
  const staleJD = await prisma.job.updateMany({
    where: { jdBatchId: { not: null }, updatedAt: { lt: fifteenMinutesAgo } },
    data: { jdBatchId: null }
  });
  console.log(`Cleared ${staleJD.count} stale JD batch leases.`);
  
  const staleLocal = await prisma.job.updateMany({
    where: { batchJobId: { not: null }, scoringStatus: 'scoring', updatedAt: { lt: fifteenMinutesAgo } },
    data: { batchJobId: null, scoringStatus: 'queued' }
  });
  console.log(`Cleared ${staleLocal.count} stale local scoring leases.`);

  // 4. Jobs marked as "archived" by mistake instead of dismissed?
  // Wait, the prompt says "jobs are getting stuck in statuses like 'needs_jd', 'queued', or 'archived' by mistake."
  // So let's look at jobs that are in `archived` status, but maybe they shouldn't be?
  // Wait, if they were put into `archived` by batch-jd-submit because they were duplicates, that's not a mistake!
  // Wait, what if they were put into `archived` because of ingestion failure?
  // Let's just reset all `archived` jobs to `pending_af` and `needs_jd` if they have `aimFitScore: null`?
  // No, if the user explicitly archived them, we don't want to un-archive them.
  // Wait, how does a job get archived BY MISTAKE?
  // If `status` is `archived` but `jdBatchId` is not null?
  // Or if `status` is `archived` but it has `scoringStatus: needs_jd`?
  
  const mistakenlyArchived = await prisma.job.updateMany({
    where: {
      status: 'archived',
      scoringStatus: { in: ['queued', 'needs_jd', 'scoring'] }, // Shouldn't be active if archived
    },
    data: {
      status: 'pending_af',
    }
  });
  console.log(`Unstuck ${mistakenlyArchived.count} mistakenly archived jobs.`);
}

unstickJobs()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
