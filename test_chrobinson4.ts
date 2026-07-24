import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.findMany({ where: { company: { contains: 'Robinson' }, status: 'applied' } });
  jobs.forEach(j => {
    console.log(`ID: ${j.id}, Status: ${j.status}, Title: ${j.title}`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
