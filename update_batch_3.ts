import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "431232be-9690-4da1-b804-bae8f12016d7",
    "433d40de-5ee4-415b-a89c-59695aaa0d8e",
    "4347769a-b223-472e-8bcb-b6ec666b45e1",
    "4a57d7ab-33f6-475a-831f-9f45c095e6ca",
    "4b94bc55-6b4d-4030-b945-a73a7de90d16",
    "4c864e34-c782-47de-bc57-1b3ca47d1bca",
    "4cfbb7bd-09ef-41e1-8f02-8e0f723e46a1",
    "4d994520-c6b9-4420-807c-f3616e7e60ee",
    "53cdf72b-79c8-4adb-bca0-e98f6a37456f",
    "55629b83-6b17-49e2-b48e-f32d8229d6ae"
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
