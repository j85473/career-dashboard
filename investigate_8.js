const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Check if there are ANY duplicate fingerprints in the Job table
  // Since it might be unique constrained, we can check the schema or query.
  
  const jobs = await prisma.job.groupBy({
    by: ['fingerprint'],
    having: {
      fingerprint: {
        _count: {
          gt: 1
        }
      }
    },
    _count: {
      fingerprint: true
    }
  });
  
  console.log(`Found ${jobs.length} duplicate fingerprints.`);
  
  // Let's check when the oldest orphaned JobScoreEvent was created.
  // Actually, let's see if we can find WHEN the deletion happened.
  // We can't directly, but we can look for jobs created after yesterday and see if they have fingerprints.
  
}

main().catch(console.error).finally(() => prisma.$disconnect());
