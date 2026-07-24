import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const job = await prisma.job.findUnique({
    where: { id: '8e8de00e-ff23-498e-84b0-49076256f032' },
  });
  console.log('Job:', job);
}

main().catch(console.error).finally(() => prisma.$disconnect());
