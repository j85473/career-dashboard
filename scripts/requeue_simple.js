const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const res = await prisma.job.updateMany({
    where: { scoringStatus: 'scored', status: { in: ['pending_af', 'inbox'] } },
    data: { scoringStatus: 'queued', batchJobId: null, jdBatchId: null }
  });
  console.log("Re-queued", res.count, "jobs");
}
run().then(() => prisma.$disconnect()).catch(console.error);
