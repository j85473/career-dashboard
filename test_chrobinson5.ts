import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const job = await prisma.job.findUnique({ where: { id: '9bf5553d-cd9c-4899-a7d1-d704752b432e' }});
  console.log(`Status: ${job?.status}, UpdatedAt: ${job?.updatedAt}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
