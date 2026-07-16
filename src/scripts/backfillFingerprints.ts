import { PrismaClient } from '@prisma/client';
import { generateFingerprint } from '../lib/jobIngestion';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { fingerprint: null },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Found ${jobs.length} jobs with missing fingerprints.`);

  let deletedCount = 0;
  let updatedCount = 0;

  for (const job of jobs) {
    const fingerprint = generateFingerprint(job.title, job.company);
    
    // Check if a job with this fingerprint already exists
    const existing = await prisma.job.findFirst({
      where: {
        fingerprint,
        id: { not: job.id }
      }
    });

    if (existing) {
      console.log(`Deleting duplicate job: ${job.company} - ${job.title}`);
      await prisma.job.delete({ where: { id: job.id } });
      deletedCount++;
    } else {
      await prisma.job.update({
        where: { id: job.id },
        data: { fingerprint }
      });
      updatedCount++;
    }
  }

  console.log(`Done! Updated ${updatedCount}, Deleted ${deletedCount} duplicates.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
