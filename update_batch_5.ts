import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "6be59880-a48d-4fbc-839c-c463f6c7c7aa",
    "6c5fffb2-4971-4487-948b-e0627b92fbc3",
    "6cd00035-bde6-4307-9798-b0849b3fa5b3",
    "6d36053c-ae8b-4438-8bcd-9272f30f41cd",
    "6e93270d-ac30-4a93-8cde-fa9bf978d969",
    "70e5c485-dd06-49fd-ac11-c8504bb39359",
    "7145b78c-d68e-48cf-89ae-d5fb2e978c08",
    "72751a6c-43d0-4ed0-8b02-366ee2b75cab",
    "79910621-33bf-4b02-aca2-43d78738b873",
    "7adfc8d9-8f93-4ffd-a0aa-4f308bba7815"
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
