import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.job.count({
    where: { 
      luckyStatus: 'inbox',
      reqFitScore: null
    },
  });
  console.log('Count:', count);
}
main().catch(console.error).finally(() => prisma.$disconnect());
