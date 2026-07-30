import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const groups = await prisma.job.groupBy({
    by: ['status', 'scoringStatus'],
    _count: { id: true },
  });
  console.log(groups);
}
main().catch(console.error).finally(() => prisma.$disconnect());
