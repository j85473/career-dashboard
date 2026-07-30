import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'passed',
      contextBatched: false
    },
    take: 10,
    select: {
      id: true,
      title: true,
      company: true
    }
  });
  console.log(JSON.stringify(jobs));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
