import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "8b922834-a779-4e7f-8206-77c0c704c89e",
    "8c82825b-fe38-41d2-813c-26d41f506527",
    "8d1fdc2e-be6e-415d-9ad5-1c966efc98a8",
    "8e8de00e-ff23-498e-84b0-49076256f032",
    "90d375fd-5bb4-4232-a4ba-526af7728cec",
    "9140c78a-2ad9-44af-8bb3-9aae9bdcb8d7",
    "9251b0cf-1fbe-45b0-bebd-5a51d077829c",
    "94209c1d-a632-4bd1-bb49-467275a9a2cd",
    "94d5844a-8ff4-4038-89f2-e54342049c1d",
    "95629042-e8e1-4892-8728-e74bb0f458f9"
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
