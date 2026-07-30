import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("Moving 'pending' jobs (AI fit queue) back to 'pending_af' (Local score queue)...");
  
  const result = await prisma.job.updateMany({
    where: {
      status: 'pending'
    },
    data: {
      status: 'pending_af',
      scoringStatus: 'queued',
      fitScore: null,
      fitCategory: 'unscored',
      fitRationale: null,
      passReason: null,
      travelScore: null, // Depending on if it's local or AI, better to clear just in case
      scoreAttempts: 0,
      scoreError: null
    }
  });

  console.log(`Successfully moved and cleared local scores for ${result.count} jobs.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
