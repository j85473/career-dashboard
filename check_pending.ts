import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const pendingJobs = await prisma.job.findMany({
    where: { status: 'pending' },
    take: 5
  });
  console.log("Pending Jobs (AI queue):");
  pendingJobs.forEach(j => {
    console.log(`- ID: ${j.id}, fitScore: ${j.fitScore}, fitCategory: ${j.fitCategory}, aimFitScore: ${j.aimFitScore}`);
  });

  const pendingAfJobs = await prisma.job.findMany({
    where: { status: 'pending_af' },
    take: 5
  });
  console.log("\nPending AF Jobs (Local queue):");
  pendingAfJobs.forEach(j => {
    console.log(`- ID: ${j.id}, fitScore: ${j.fitScore}, fitCategory: ${j.fitCategory}, aimFitScore: ${j.aimFitScore}`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
