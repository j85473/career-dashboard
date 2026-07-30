import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const events = await prisma.jobScoreEvent.findMany({
    select: { jobId: true }
  });
  const allIds = [...new Set(events.map(e => e.jobId))];
  
  const existingJobs = await prisma.job.findMany({
    where: { id: { in: allIds } },
    select: { id: true }
  });
  const existingSet = new Set(existingJobs.map(j => j.id));
  
  const orphanedIds = allIds.filter(id => !existingSet.has(id));
  console.log(`Found ${orphanedIds.length} orphaned jobIds.`);
  if (orphanedIds.length > 0) {
    const fs = require('fs');
    fs.writeFileSync('scratch/orphaned_ids.json', JSON.stringify(orphanedIds, null, 2));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
