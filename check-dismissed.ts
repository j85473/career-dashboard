import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { status: 'dismissed' },
    select: { id: true, title: true, status: true, fitCategory: true, updatedAt: true, createdAt: true }
  });
  console.log(`Found ${jobs.length} dismissed jobs.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
