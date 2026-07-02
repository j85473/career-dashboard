import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const processingCount = await prisma.job.count({ where: { jdBatchId: 'processing' } });
  console.log(`processingCount: ${processingCount}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
