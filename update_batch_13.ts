import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "d05a8546-b9b4-436a-b589-04a58a0c3708",
    "f0336672-284e-43ae-9e28-b7583767dd04",
    "f3f17275-7b55-4a3e-8c1b-bd934c2f3aad",
    "f4636668-2960-4322-a2f0-bbe6912117f3",
    "f6ec3dbb-8cf3-4a46-8b94-2f5ba85e6c5a",
    "f7bb406d-1787-44be-bef3-c174a5916203",
    "fcacf079-d05f-4d24-8b11-404f4b4e8a56",
    "feb6e1b8-b2be-461b-b503-94c6c86ad8ed"
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
