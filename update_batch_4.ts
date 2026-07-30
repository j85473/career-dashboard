import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "560aaca0-b83c-4786-a38e-01d6d7526011",
    "56292ecc-98aa-4ad3-9e63-6c9f77101ce0",
    "57b361b3-f7ab-42f7-a12a-cc49dbb23c71",
    "5bcbd7a4-9d82-47dd-b4f1-060cdc86806e",
    "60be80c3-972a-445e-8a23-1c651c13d888",
    "629588ef-c93b-4c20-9a3b-75529eaec363",
    "6384da25-8193-4de1-b140-b37225febd04",
    "6ab87d57-c909-453c-860a-0cf1ca181141",
    "6b01a8e2-14c7-4228-8597-3cd55f7e68ed",
    "6b794c5a-c2f3-4d95-995a-c10fc2c67478"
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
