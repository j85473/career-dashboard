const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const statusCounts = await prisma.job.groupBy({
    by: ['status'],
    _count: {
      id: true,
    },
    orderBy: {
      _count: {
        id: 'desc'
      }
    }
  });

  console.log("Current job counts by status:");
  console.table(statusCounts);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 2); // go back a bit further just in case

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
  console.table(recentlyUpdatedCounts);
  
  const submittedResumeCounts = await prisma.job.groupBy({
    by: ['status'],
    where: {
      submittedResume: {
        not: null
      }
    },
    _count: {
      id: true
    }
  });
  console.log("\nJobs with a submittedResume, grouped by status:");
  console.table(submittedResumeCounts);

  const recentUpdates = await prisma.job.findMany({
    where: {
      updatedAt: {
        gte: yesterday
      }
    },
    orderBy: {
      updatedAt: 'desc'
    },
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      createdAt: true
    },
    take: 20
  });
  console.log("\nRecent 20 job updates:");
  console.table(recentUpdates);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
