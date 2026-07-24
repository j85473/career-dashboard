import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  await prisma.$executeRawUnsafe(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND datname = current_database();
  `);
  console.log("Terminated other connections.");
}
run().finally(() => prisma.$disconnect());
