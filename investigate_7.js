const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find JobScoreEvents where the jobId does not exist in the Job table
  // Since we have a lot of events, we can just do a raw SQL query or check a few manually.
  
  console.log("Looking for orphaned JobScoreEvents...");
  
  // Actually Prisma doesn't support left join directly in findMany,
  // but we can just fetch distinct jobIds from JobScoreEvent and check if they exist.
  // Let's do this efficiently.
  
  const scoreEvents = await prisma.jobScoreEvent.findMany({
    select: { jobId: true },
    distinct: ['jobId']
  });
  
  const eventJobIds = scoreEvents.map(e => e.jobId);
  console.log(`Found ${eventJobIds.length} distinct jobIds in JobScoreEvent.`);
  
  // Now count how many of these exist in Job table
  const existingJobs = await prisma.job.count({
    where: {
      id: { in: eventJobIds }
    }
  });
  
  console.log(`Of these, ${existingJobs} exist in the Job table.`);
  console.log(`Orphaned JobScoreEvents: ${eventJobIds.length - existingJobs}`);
  
  // Let's check ContextRuleRevision as well
  const revisions = await prisma.contextRuleRevision.findMany({
    select: { sourceJobIds: true }
  });
  
  let totalSourceIds = new Set();
  revisions.forEach(rev => rev.sourceJobIds.forEach(id => totalSourceIds.add(id)));
  const uniqueSourceIds = Array.from(totalSourceIds);
  console.log(`Found ${uniqueSourceIds.length} distinct sourceJobIds in ContextRuleRevisions.`);
  
  const existingSourceJobs = await prisma.job.count({
    where: {
      id: { in: uniqueSourceIds }
    }
  });
  console.log(`Of these, ${existingSourceJobs} exist in the Job table.`);
  console.log(`Orphaned ContextRuleRevision source jobs: ${uniqueSourceIds.length - existingSourceJobs}`);
  
  // Wait, if jobs were DELETED, then that would explain where they went.
}

main().catch(console.error).finally(() => prisma.$disconnect());
