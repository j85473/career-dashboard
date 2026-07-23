import { prisma } from './src/lib/prisma';
async function run() {
  const pending = await prisma.job.count({
    where: { status: { in: ['inbox', 'pending_af'] }, scoringStatus: 'scored', afBatchId: null, aimFitScore: null }
  });
  console.log("Pending AI Eval:", pending);
}
run();
