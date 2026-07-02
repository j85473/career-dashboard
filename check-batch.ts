import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { jdBatchId: { not: null } },
    select: { id: true, title: true, status: true, jdBatchId: true }
  });
  console.log(`Found ${jobs.length} jobs with jdBatchId.`);
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
