import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { company: { contains: 'home depot', mode: 'insensitive' } },
    select: { company: true, createdAt: true, status: true, aimFitScore: true },
    take: 5
  });
  console.log("Home Depot jobs:", jobs);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
