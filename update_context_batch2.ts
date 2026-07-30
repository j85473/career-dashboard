import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const results = [
  { "id": "14f24304-6330-466d-88ab-d7164eb0fdb4" },
  { "id": "1691f148-5c4d-4447-9750-f8a4eec9313a" },
  { "id": "173489ab-1234-5678-abcd-1234567890ab" },
  { "id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" },
  { "id": "1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e" }
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
