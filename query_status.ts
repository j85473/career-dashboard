import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const locks = await prisma.$queryRawUnsafe(`
    SELECT pid, state, query, extract(epoch from now() - query_start) as duration_seconds
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND datname = current_database()
      AND state != 'idle';
  `);
  console.log("Active queries:", locks);
}
run().finally(() => prisma.$disconnect());
