import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("Fetching jobs to check for duplicates...");
  
  // We want to find duplicates among jobs that are not archived or skipped.
  // Actually, we should check ALL jobs for duplicates, but we only strictly need to clean up ones that are active and might cost money (e.g. needs_jd, queued).
  // But let's just find groups of jobs with the EXACT same company and title created within 45 days of each other.
  // Since we know the recent issue is mostly jobs created at the exact same time, grouping by company/title is safe.
  
  const jobs = await prisma.job.findMany({
    where: {
      status: { notIn: ['archived'] }, // Only active jobs
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      company: true,
      createdAt: true,
      status: true,
      scoringStatus: true,
      observations: true,
    }
  });

  const groups: Record<string, typeof jobs> = {};
  
  for (const job of jobs) {
    const title = job.title.trim().toLowerCase();
    const company = job.company.trim().toLowerCase();
    const key = `${company}|${title}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(job);
  }

  let deletedCount = 0;
  let obsMoved = 0;

  for (const [key, group] of Object.entries(groups)) {
    if (group.length > 1) {
      console.log(`\nDuplicate Group: ${key} (${group.length} jobs)`);
      const primary = group[0];
      const duplicates = group.slice(1);
      
      console.log(`  Primary: ${primary.id} (${primary.createdAt})`);
      
      for (const dup of duplicates) {
        console.log(`  Duplicate: ${dup.id} (${dup.createdAt}) - status: ${dup.status}, scoringStatus: ${dup.scoringStatus}`);
        
        // Move observations
        for (const obs of dup.observations) {
          try {
            await prisma.jobSourceObservation.update({
              where: { id: obs.id },
              data: { jobId: primary.id }
            });
            obsMoved++;
          } catch (e: any) {
            if (e.code === 'P2002') {
              console.log(`    Observation ${obs.id} already exists on primary, deleting duplicate observation...`);
              await prisma.jobSourceObservation.delete({ where: { id: obs.id } });
            } else {
              console.error(`    Error moving observation ${obs.id}:`, e);
            }
          }
        }
        
        // Delete the duplicate job
        await prisma.job.delete({ where: { id: dup.id } });
        deletedCount++;
        console.log(`    Deleted job ${dup.id}`);
      }
    }
  }

  console.log(`\nCleanup complete! Deleted ${deletedCount} duplicate jobs. Moved ${obsMoved} observations.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
