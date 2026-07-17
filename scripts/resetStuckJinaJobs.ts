import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Resetting stuck Jina jobs...");

  const result = await prisma.job.updateMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'needs_jd',
      scoreAttempts: { gte: 3 }
    },
    data: {
      scoreAttempts: 0,
      scoreError: null,
      jdBatchId: null
    }
  });
  
  console.log(`Reset ${result.count} stuck jobs back to 0 attempts.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
