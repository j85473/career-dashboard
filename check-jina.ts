import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const needsJd = await prisma.job.count({ where: { scoringStatus: 'needs_jd', jdBatchId: null } });
  const failed = await prisma.job.count({ where: { scoringStatus: 'failed' } });
  const processing = await prisma.job.count({ where: { jdBatchId: { not: null } } });
  const totalInBatch = await prisma.job.findMany({
    where: { jdBatchId: { not: null } },
    select: { jdBatchId: true }
  });
  
  console.log({ needsJd, failed, processing, batches: Array.from(new Set(totalInBatch.map(j => j.jdBatchId))) });
}
main().catch(console.error).finally(() => prisma.$disconnect());
