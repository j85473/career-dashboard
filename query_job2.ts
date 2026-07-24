import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const job = await prisma.job.findUnique({
    where: { id: 'c227537e-059f-482a-835d-c11b31189fd4' },
  });
  console.log(job);
}
main().catch(console.error).finally(() => prisma.$disconnect());
