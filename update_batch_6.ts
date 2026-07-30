import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "7b3f9089-bd72-457f-84f5-e6a3435f624b",
    "7d9ef66a-4604-4a3e-9c8a-3f83c89d5964",
    "80ceac3e-4972-4921-a219-c330dcf50d99",
    "837c681c-7730-4aeb-a228-eed76334552f",
    "83e0b453-a568-4f06-8671-1b63d66db194",
    "84244dc6-cfff-4cc7-a8c7-54e8106387e0",
    "86cdd557-6668-4d4e-b5e4-1e323d7af197",
    "87605ec5-3129-467b-9800-a9f7babfe5f5",
    "8816888f-2a98-40f4-bbbb-735575289edb",
    "8a42743d-bee9-42a4-a02e-a294cdf3cb41"
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
