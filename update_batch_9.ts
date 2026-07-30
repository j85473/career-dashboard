import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "a28aeecc-15d0-4652-8be9-6308361c6896",
    "a461f08a-c7d8-4d37-bd5f-f863ffb8467f",
    "a575813c-5705-4bf2-9833-25babe608891",
    "a7425a8b-3407-4368-b51f-95ec137d6d21",
    "a7e763d7-2412-4b0b-89a6-3d337bb24933",
    "abcb624a-a944-4f36-967a-77e32af6dbfb",
    "af5ce8b2-10a1-4ced-8560-be91ac7d9953",
    "b321640b-8e9f-47f8-934d-30c79d82c95f",
    "b663b059-60df-4e72-9a85-bfb4098f7271",
    "b75903e0-3bed-4ef4-8a10-91ab809db4c3"
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
