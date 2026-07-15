import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const result = await prisma.job.updateMany({
    where: {
      status: 'pending_af',
      scoringStatus: 'scored'
    },
    data: {
      aimFitScore: null,
      reqFitScore: null,
      passReason: null,
      reqFitRationale: null
    }
  });
  console.log(`Reset ${result.count} stuck jobs.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
