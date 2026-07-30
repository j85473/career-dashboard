const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const res = await prisma.$queryRawUnsafe(`
    SELECT relation::regclass::text, mode, granted, pid
    FROM pg_locks
    WHERE relation IS NOT NULL;
  `);
  console.log("Locks:");
  console.table(res);
}
run().then(() => prisma.$disconnect()).catch(console.error);
