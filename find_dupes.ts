import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const dupes = await prisma.$queryRawUnsafe(`
    SELECT fingerprint, COUNT(*) as count
    FROM "Job"
    GROUP BY fingerprint
    HAVING COUNT(*) > 1;
  `);
  console.log("Found duplicates:", dupes);
}
run().finally(() => prisma.$disconnect());
