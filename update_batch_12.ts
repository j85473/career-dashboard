import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "d26d258f-2265-4ed9-93f5-8dc618a2b4b7",
    "d8b953f1-e84f-4f79-a7b8-17b1ff5bc960",
    "d919e583-3d8f-4d66-adf7-64eefd1ce9fa",
    "df139bc7-3ed4-4b2b-abc5-3751fd92a34d",
    "e26feff6-5871-46a3-9c83-0ca2858c9700",
    "ea721dde-4928-4f42-b3bc-ab27641dae18",
    "eb2c429a-b075-431c-96a1-94c3491d66e6",
    "eca40650-df85-4079-afe9-3ef8f1bd5b63",
    "ed3fb79f-6253-468f-881a-f640352e1cb0",
    "f01068f2-261e-4233-9fb5-1a081de47cf7"
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
