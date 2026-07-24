import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const job = await prisma.job.findUnique({
    where: { id: '423fee73-331f-4690-ad4d-2742c1cff090' },
  });
  console.log('Job:', job);
}

main().catch(console.error).finally(() => prisma.$disconnect());
