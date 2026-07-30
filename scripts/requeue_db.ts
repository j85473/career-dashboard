import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const result = await prisma.job.updateMany({
    where: {
      scoringStatus: 'scored',
      status: { in: ['pending_af', 'inbox'] }
    },
    data: {
      scoringStatus: 'queued',
      batchJobId: null,
      jdBatchId: null
    }
  });
  console.log(`Re-queued ${result.count} jobs for local scoring.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
