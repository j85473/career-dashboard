import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "c70ae30f-6df6-4aa1-bda0-e5c5d678557e",
    "c7723dc2-1873-4b67-9584-13d2bfcddeef",
    "c9b628c6-cb26-41af-8a06-d5c6a1240aae",
    "cad6efde-882a-4aff-8b2f-659dc4b6c7fe",
    "cc14ccbc-9a06-4701-adf4-87c1e7ad22fd",
    "cca662b0-996b-4698-8e2d-52d7056d8481",
    "cccaafd0-0e88-41d5-8d7c-677b88c608b9",
    "cd2883fb-c389-417d-8275-d25df615beab",
    "ce634c30-4aa6-42ab-b78b-a6dc3cec105a",
    "d14884b4-b413-406e-98ba-3660ba174a86"
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
