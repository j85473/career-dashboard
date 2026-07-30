const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const archivedReasons = await prisma.job.groupBy({
    by: ['passReason'],
    where: {
      status: 'archived',
      updatedAt: { gte: yesterday }
    },
    _count: { id: true }
  });

  console.log("Archived jobs passReason distribution:");
  console.log(archivedReasons);

  // We are specifically looking for the 200 missing 'applied' jobs.
  // Could they have been moved to 'cooldown'? There were 897 cooldown jobs.
  // Wait, the user said they disappeared from the "applied" folder.
  // What if the user had 300+ jobs in the "applied" folder yesterday, and now 114.
  // We can't identify WHICH jobs were in "applied" yesterday unless we look for 
  // jobs that have a property that is UNIQUE to applied jobs.
  // Is there any property? No, but maybe `manualAts` is set when applying?
  // Let's check `manualAts` distribution.

  const manualAtsStatuses = await prisma.job.groupBy({
    by: ['status'],
    where: {
      manualAts: { not: null },
      updatedAt: { gte: yesterday }
    },
    _count: { id: true }
  });
  console.log("Recently updated jobs with manualAts, by status:", manualAtsStatuses);

  // What about jobs where the user manually invoked an action?
  // Did they run a cleanup script? 
  // Let's look at jobs that were "applied" but now "archived" by seeing if they have a non-null aimFitScore or something.
  const archivedScored = await prisma.job.count({
    where: {
      status: 'archived',
      aimFitScore: { not: null },
      updatedAt: { gte: yesterday }
    }
  });
  console.log("Recently archived jobs with an aimFitScore:", archivedScored);
}

main().catch(console.error).finally(() => prisma.$disconnect());
