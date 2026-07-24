import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  try {
    const res = await prisma.$queryRawUnsafe(`
      EXPLAIN UPDATE "Job" as j
      SET fingerprint = CAST(v.hash AS text)
      FROM (VALUES ('foo', 'bar')) AS v(id, hash)
      WHERE j.id = CAST(v.id AS text);
    `);
    console.log("Plan", res);
  } catch (e) {
    console.error("Error", e);
  }
}
run().finally(() => prisma.$disconnect());
