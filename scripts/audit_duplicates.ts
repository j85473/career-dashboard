import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { not: 'archived' }
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      url: true,
      canonicalUrl: true,
      scoringStatus: true
    }
  });

  const duplicateMap = new Map<string, typeof jobs>();
  
  for (const job of jobs) {
    // Basic normalization for grouping
    const normCompany = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normTitle = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${normCompany}|${normTitle}`;
    
    if (!duplicateMap.has(key)) {
      duplicateMap.set(key, []);
    }
    duplicateMap.get(key)!.push(job);
  }

  let totalDuplicates = 0;
  let totalGroups = 0;
  
  console.log("Groups with multiple jobs (Same Company & Same Title):");
  for (const [key, group] of duplicateMap.entries()) {
    if (group.length > 1) {
      totalGroups++;
      totalDuplicates += (group.length - 1);
      if (totalGroups <= 5) {
        console.log(`\nGroup: ${group[0].company} - ${group[0].title}`);
        for (const j of group) {
           console.log(`  - ID: ${j.id} | URL: ${j.url || j.canonicalUrl} | Status: ${j.scoringStatus}`);
        }
      }
    }
  }
  
  console.log(`\nTotal duplicate groups: ${totalGroups}`);
  console.log(`Total excess duplicate jobs in queue/system: ${totalDuplicates}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
