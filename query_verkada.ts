import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.findMany({
    where: { company: { contains: 'erkada' } },
    select: { id: true, company: true, status: true, luckyStatus: true, title: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
