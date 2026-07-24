import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.findMany({ 
    where: { company: { contains: 'Robinson' } }
  });
  jobs.forEach(j => {
    console.log(`ID: ${j.id}, Company: "${j.company}"`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
