import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.job.update({
    where: { id: '423fee73-331f-4690-ad4d-2742c1cff090' },
    data: { status: 'dismissed' },
  });
  console.log('Fixed');
}

main().catch(console.error).finally(() => prisma.$disconnect());
