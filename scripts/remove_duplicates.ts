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
      scoringStatus: true,
      status: true
    }
  });

  const duplicateMap = new Map<string, typeof jobs>();
  
  for (const job of jobs) {
    const normCompany = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normTitle = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${normCompany}|${normTitle}`;
    
    if (!duplicateMap.has(key)) {
      duplicateMap.set(key, []);
    }
    duplicateMap.get(key)!.push(job);
  }

  let archiveCount = 0;
  
  for (const [key, group] of duplicateMap.entries()) {
    if (group.length > 1) {
      // Sort to pick the best one to keep
      // Priority: scored > queued > needs_jd
      const getPriority = (status: string) => {
        if (status === 'scored') return 3;
        if (status === 'queued') return 2;
        if (status === 'needs_jd') return 1;
        return 0;
      };
      
      group.sort((a, b) => getPriority(b.scoringStatus || '') - getPriority(a.scoringStatus || ''));
      
      // The first one is the winner
      const winner = group[0];
      const losers = group.slice(1);
      
      for (const loser of losers) {
        await prisma.job.update({
          where: { id: loser.id },
          data: {
            status: 'archived',
            scoringStatus: 'skipped',
            passReason: `Duplicate of ${winner.id}`
          }
        });
        archiveCount++;
      }
    }
  }
  
  console.log(`Successfully archived ${archiveCount} duplicate jobs.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
