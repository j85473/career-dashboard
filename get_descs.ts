import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ids = [
  "84244dc6-cfff-4cc7-a8c7-54e8106387e0",
  "86cdd557-6668-4d4e-b5e4-1e323d7af197",
  "87605ec5-3129-467b-9800-a9f7babfe5f5",
  "8816888f-2a98-40f4-bbbb-735575289edb",
  "8a42743d-bee9-42a4-a02e-a294cdf3cb41"
];

async function main() {
  const jobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, company: true, description: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
