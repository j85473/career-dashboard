import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    "1e99f0c0-d0a2-4fe4-ab57-d2e6636c683f",
    "238de9cb-1c9b-4d6b-a771-0ba24a8a4992",
    "23bfe04a-dd27-482e-9316-82e27bb84e8f",
    "2538509c-90a9-46c4-84d5-07f344da3e94",
    "25940eae-b4b1-4d62-a293-93bfce88cb14"
  ];
  
  const jobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, company: true, description: true, location: true }
  });
  
  console.log(JSON.stringify(jobs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
