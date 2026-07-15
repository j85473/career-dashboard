import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'pending_af',
      scoringStatus: 'scored'
    }
  });
  console.log(JSON.stringify(jobs.map(j => ({id: j.id, aimFitScore: j.aimFitScore, reqFitScore: j.reqFitScore, passReason: j.passReason, reqFitRationale: j.reqFitRationale})), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
