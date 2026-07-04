import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.job.updateMany({
    where: { afBatchId: { not: null } },
    data: { afBatchId: null }
  });
  console.log(`Reset ${result.count} jobs stuck in processing.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
