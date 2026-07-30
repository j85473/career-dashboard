const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  console.log("Killing all connections...");
  await prisma.$executeRawUnsafe(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND datname = 'career_db';
  `);
  console.log("Connections killed. Requeuing...");
  const res = await prisma.job.updateMany({
    where: { scoringStatus: 'scored', status: { in: ['pending_af', 'inbox'] } },
    data: { scoringStatus: 'queued', batchJobId: null, jdBatchId: null }
  });
  console.log("Re-queued", res.count, "jobs");
}
run().then(() => prisma.$disconnect()).catch(console.error);
