import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const counts = await prisma.job.groupBy({
    by: ['status'],
    _count: { id: true }
  });
  console.log("Job status counts:", counts);
}
main().catch(console.error).finally(() => prisma.$disconnect());
