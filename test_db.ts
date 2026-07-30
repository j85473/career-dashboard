import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.count({
    where: { contextBatched: false, status: { in: ['passed', 'applied'] } }
  });
  console.log(`Unbatched context DB jobs: ${jobs}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
