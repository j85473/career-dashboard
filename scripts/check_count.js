const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const res = await prisma.job.count({
    where: { scoringStatus: 'scored', status: { in: ['pending_af', 'inbox'] } }
  });
  console.log("Jobs to update:", res);
}
run().then(() => prisma.$disconnect()).catch(console.error);
