const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const archivedNullReason = await prisma.job.count({
    where: {
      status: 'archived',
      passReason: null,
      updatedAt: { gte: yesterday }
    }
  });

  console.log("Archived jobs with passReason: null in last 24h:", archivedNullReason);

  // Maybe the 200 jobs were moved to 'dismissed'?
  const dismissedNullReason = await prisma.job.count({
    where: {
      status: 'dismissed',
      passReason: null,
      updatedAt: { gte: yesterday }
    }
  });
  console.log("Dismissed jobs with passReason: null in last 24h:", dismissedNullReason);

  // Let's find jobs that were updated in the last 24h that DO NOT have a JobScoreEvent.
  // Because if they were 'applied', they might have been scored long ago, or manually applied.
  // We can look for jobs updated today, with status 'archived' or 'dismissed', that HAVE an aimFitScore,
  // but the aimFitScore was NOT generated today (i.e. JobScoreEvent is old).
  const oldScoreJobs = await prisma.job.findMany({
    where: {
      status: { in: ['archived', 'dismissed'] },
      updatedAt: { gte: yesterday },
      aimFitScore: { not: null }
    },
    select: { id: true, status: true, passReason: true, updatedAt: true },
    take: 10
  });

  console.log("Sample of recently updated jobs that have an aimFitScore (should be from before):");
  console.log(oldScoreJobs);
}

main().catch(console.error).finally(() => prisma.$disconnect());
