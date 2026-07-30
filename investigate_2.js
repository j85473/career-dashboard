const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 2);

  const recentlyUpdatedCounts = await prisma.job.groupBy({
    by: ['status'],
    where: {
      updatedAt: {
        gte: yesterday
      }
    },
    _count: {
      id: true,
    }
  });
  
  console.log("\nRecently updated job counts by status (last 48h):");
  console.log(recentlyUpdatedCounts);

  // Look for jobs that might have been applied but are now archived or passed or expired
  // Maybe they have a submittedResume or manualAts or cooldownUntil?
  const possiblyApplied = await prisma.job.groupBy({
    by: ['status'],
    where: {
      OR: [
        { submittedResume: { not: null } },
        { manualAts: { not: null } },
        { tailoringStaged: true }
      ]
    },
    _count: {
      id: true
    }
  });

  console.log("\nJobs with submittedResume OR manualAts OR tailoringStaged, grouped by status:");
  console.log(possiblyApplied);
  
  const archivedRecently = await prisma.job.count({
    where: {
      status: 'archived',
      updatedAt: { gte: yesterday }
    }
  });
  console.log("\nJobs archived in the last 48h:", archivedRecently);

  const expiredRecently = await prisma.job.count({
    where: {
      status: 'expired',
      updatedAt: { gte: yesterday }
    }
  });
  console.log("\nJobs expired in the last 48h:", expiredRecently);
  
  // Look at the manualAts and submittedResume for archived jobs
  const archivedAppliedCount = await prisma.job.count({
    where: {
      status: 'archived',
      OR: [
        { submittedResume: { not: null } },
        { manualAts: { not: null } }
      ]
    }
  });
  console.log("\nArchived jobs that have submittedResume or manualAts:", archivedAppliedCount);

}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
