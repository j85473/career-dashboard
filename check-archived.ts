import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { status: 'archived' },
    select: { id: true, title: true, status: true, passReason: true, updatedAt: true, createdAt: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
