const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const res = await prisma.$queryRawUnsafe(`
    SELECT pid, state, query, state_change
    FROM pg_stat_activity
    WHERE pid = 928451;
  `);
  console.log(res);
}
run().then(() => prisma.$disconnect()).catch(console.error);
