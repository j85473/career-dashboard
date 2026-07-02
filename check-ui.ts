import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const needsJdQueued = await prisma.job.count({
    where: {
      jdBatchId: null,
      scoringStatus: 'needs_jd',
      status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] }
    }
  });
  console.log(`UI needsJdQueued count: ${needsJdQueued}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
