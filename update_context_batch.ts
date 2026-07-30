import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const results = [
  { "id": "0e3695ff-77de-4810-b3c0-72a38ab2a368" },
  { "id": "0f247ca5-806b-4d27-92a0-49b3c3ae3353" },
  { "id": "0f453cac-eeef-4035-9e15-6964ca61b604" },
  { "id": "121479ef-62ee-4783-bb5a-420c4755b4be" },
  { "id": "13598b1a-6044-4536-b835-055d12a17fab" }
];

async function main() {
  const ids = results.map(r => r.id);
  await prisma.job.updateMany({
    where: { id: { in: ids } },
    data: { contextBatched: true }
  });
  console.log(`Updated ${ids.length} jobs.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
