const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // We want to find jobs that MIGHT have been 'applied' before.
  // We can't know for sure without a history table, but we can look for
  // jobs that are currently NOT applied, but were updated in the last 24h,
  // and have tell-tale signs of being an application, such as:
  // - They are in context profile (contextBatched = true)
  // - They have submittedResume set
  // - Their manualAts is set
  // Let's see the most common statuses of these recently updated jobs.

  const recentSuspects = await prisma.job.groupBy({
    by: ['status'],
    where: {
      status: { not: 'applied' },
      updatedAt: { gte: yesterday },
      OR: [
        { contextBatched: true },
        { submittedResume: { not: null } },
        { manualAts: { not: null } },
        { status: 'archived' } // maybe they just got archived?
      ]
    },
    _count: { id: true }
  });

  console.log("Status distribution of recently updated suspect jobs:");
  console.log(recentSuspects);
  
  // Let's see specifically if there are jobs that got archived in the last 24h
  // that had contextBatched = true
  const contextBatchedArchived = await prisma.job.count({
    where: {
      status: 'archived',
      contextBatched: true,
      updatedAt: { gte: yesterday }
    }
  });
  console.log("Archived jobs with contextBatched=true in last 24h:", contextBatchedArchived);

  // If there are many, let's look at one of them to see its passReason or other fields.
  const sample = await prisma.job.findFirst({
    where: {
      status: 'archived',
      updatedAt: { gte: yesterday },
      contextBatched: true
    }
  });
  console.log("Sample of archived contextBatched job:", sample);
  
  // What if they got moved to "dismissed"?
  const contextBatchedDismissed = await prisma.job.count({
    where: {
      status: 'dismissed',
      contextBatched: true,
      updatedAt: { gte: yesterday }
    }
  });
  console.log("Dismissed jobs with contextBatched=true in last 24h:", contextBatchedDismissed);
  
  // What if the user ran unstickJobs and it did something?
  // We saw `unstickJobs.ts` had a mistakenlyArchived query.

  // Let's just find exactly when the massive update happened by grouping by hour of updatedAt
  const allRecentUpdates = await prisma.job.findMany({
    where: {
      updatedAt: { gte: yesterday },
      status: { notIn: ['applied', 'pending_af', 'inbox'] }
    },
    select: {
      id: true,
      status: true,
      passReason: true,
      updatedAt: true,
      contextBatched: true
    }
  });
  
  const byHour = {};
  for (const job of allRecentUpdates) {
    const hr = job.updatedAt.toISOString().substring(0, 13);
    if (!byHour[hr]) byHour[hr] = 0;
    byHour[hr]++;
  }
  console.log("Recent updates (not applied/pending/inbox) by hour:", byHour);
  
  // Find jobs that have contextBatched = true and were updated today, check their statuses
  const contextBatchedJobs = allRecentUpdates.filter(j => j.contextBatched);
  const cbStatusCounts = {};
  for (const job of contextBatchedJobs) {
    if (!cbStatusCounts[job.status]) cbStatusCounts[job.status] = 0;
    cbStatusCounts[job.status]++;
  }
  console.log("Context batched jobs that were updated today, by status:", cbStatusCounts);
}

main().catch(console.error).finally(() => prisma.$disconnect());
