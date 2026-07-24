import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.job.updateMany({
    where: { 
      luckyStatus: 'inbox',
      reqFitScore: null
    },
    data: {
      luckyStatus: 'none',
      luckyAimFitScore: null,
      luckyPassReason: null,
      scoringStatus: 'queued'
    }
  });
  console.log('Fixed count:', count.count);
}
main().catch(console.error).finally(() => prisma.$disconnect());
