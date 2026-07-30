import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const jobIds = [
  "629588ef-c93b-4c20-9a3b-75529eaec363",
  "6384da25-8193-4de1-b140-b37225febd04",
  "6ab87d57-c909-453c-860a-0cf1ca181141",
  "6b01a8e2-14c7-4228-8597-3cd55f7e68ed",
  "6b794c5a-c2f3-4d95-995a-c10fc2c67478"
];

async function main() {
  const jobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, title: true, company: true, description: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
