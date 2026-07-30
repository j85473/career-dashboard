const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  console.log("Killing idle transactions...");
  const res = await prisma.$executeRawUnsafe(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE state = 'idle in transaction';
  `);
  console.log("Killed locks. Try running the requeue script now.");
}
run().then(() => prisma.$disconnect()).catch(console.error);
