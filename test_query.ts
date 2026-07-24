import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const jobs = await prisma.job.findMany({ take: 50 });
  const values = jobs.map((job) => `('${job.id}', 'test_hash_${job.id}')`).join(',');
  const res = await prisma.$executeRawUnsafe(`
    UPDATE "Job" as j
    SET fingerprint = CAST(v.hash AS text)
    FROM (VALUES ${values}) AS v(id, hash)
    WHERE j.id = CAST(v.id AS text);
  `);
  console.log("Success", res);
}
run().finally(() => prisma.$disconnect());
