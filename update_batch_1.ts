import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "13acc6b7-bdb1-49c3-b137-4bc60afa7959",
    "18ef0796-52e4-466f-be01-ea5a67d75c19",
    "193cca36-1a59-45fd-a233-2a1df54e641f",
    "1d782230-6762-484f-8dcb-adfdcd4e9f17",
    "1e39ac5d-d0b7-41c1-b4d4-381572fe966a",
    "1e99f0c0-d0a2-4fe4-ab57-d2e6636c683f",
    "238de9cb-1c9b-4d6b-a771-0ba24a8a4992",
    "23bfe04a-dd27-482e-9316-82e27bb84e8f",
    "2538509c-90a9-46c4-84d5-07f344da3e94",
    "25940eae-b4b1-4d62-a293-93bfce88cb14"
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
