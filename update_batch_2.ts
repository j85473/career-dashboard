import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "26839852-6586-4e54-9e08-c1b18fca123f",
    "27129783-17d3-40b5-962f-f58ea47cb0e9",
    "278ecaf2-942a-4a9d-b96c-e91164e55c3c",
    "283a2533-a6be-435e-a9b7-dc9f20bddeef",
    "2940d12d-aa07-4e0f-a89f-70a1a3ba4a4f",
    "2b43d4c2-9d73-4fe5-8ee0-fba9402f69de",
    "2c49f2f8-16eb-4cb2-b143-19c2961a0817",
    "36ace14b-8c69-4bfb-bf7f-003c1be0f927",
    "3a4d27ac-506d-46fa-8c81-56827147e866",
    "40178296-87d4-48e2-939b-7bd0edf62236"
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
