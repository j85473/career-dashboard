import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const stagedJobs = await prisma.job.findMany({
    where: { tailoringStaged: true },
    select: { company: true, title: true }
  });
  console.log('Jobs still staged:', stagedJobs);
}

main().catch(console.error).finally(() => prisma.$disconnect());
