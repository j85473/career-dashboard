import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "ba84e1f6-5efc-430e-a72e-f1b716e8eb29",
    "bc6f5a39-bd09-486f-b186-36196845425b",
    "bdbbac66-c5dc-41f7-89d2-0acf66ec40bc",
    "bdde76c6-5775-4e5b-8068-a758a98d6e3b",
    "be5817e7-b35f-49e6-bbca-19650b8b9191",
    "c274d254-ac1d-4150-b782-8cfb259acf14",
    "c37fcbe4-3e4d-4a66-bc11-d2574efa33f5",
    "c4b0cdb0-136b-44aa-91c1-98a9ef5b7df6",
    "c611bc0b-151b-46f4-9b4f-f8c6ada8de79",
    "c680fc4c-2d9b-4632-afcf-cc292348e16d"
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
