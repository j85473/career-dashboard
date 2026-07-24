import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  await prisma.$executeRawUnsafe(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE pid IN (43430);
  `);
  console.log("Terminated zombie connections.");
}
run().finally(() => prisma.$disconnect());
