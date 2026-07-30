import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "95a9fc65-da20-4cae-9ce3-1747d24e5353",
    "95d96255-db1c-4a0b-ab98-a67cf76216bc",
    "9839461f-5313-4af5-a390-54105dbd8830",
    "986aa3f9-65a4-40f0-8855-cc892c1467c6",
    "9a84b31c-d646-4793-9700-3ba81887a809",
    "9bb13ec8-604b-483b-b7bb-8f3ed0eee887",
    "9cc2d06d-c2b9-4958-bf6c-29c753be3b65",
    "9e129c91-6113-46c9-9b73-1841166ef4e9",
    "a0a12446-f5f5-42df-af80-2bedb55cc189",
    "a136532f-20a2-458e-8849-21c0f43f53e4"
  ];
  const res = await prisma.job.updateMany({
    where: { id: { in: ids } },
    data: { contextBatched: true }
  });
  console.log("Updated count:", res.count);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
