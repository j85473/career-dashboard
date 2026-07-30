const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const revisions = await prisma.contextRuleRevision.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  
  console.log("Recent ContextRuleRevisions:");
  for (const rev of revisions) {
    console.log(`Revision at ${rev.createdAt}, ${rev.sourceJobIds.length} source jobs`);
    // Find how many of these source jobs are currently 'applied'
    const appliedCount = await prisma.job.count({
      where: {
        id: { in: rev.sourceJobIds },
        status: 'applied'
      }
    });
    console.log(`  - Of these, ${appliedCount} are CURRENTLY 'applied'`);
    
    // Find where the rest went
    const otherStatuses = await prisma.job.groupBy({
      by: ['status'],
      where: {
        id: { in: rev.sourceJobIds },
        status: { not: 'applied' }
      },
      _count: { id: true }
    });
    console.log(`  - Other statuses for these source jobs:`, otherStatuses);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
