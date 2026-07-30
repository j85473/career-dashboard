const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ids = [
    "9140c78a-2ad9-44af-8bb3-9aae9bdcb8d7",
    "9251b0cf-1fbe-45b0-bebd-5a51d077829c",
    "94209c1d-a632-4bd1-bb49-467275a9a2cd",
    "94d5844a-8ff4-4038-89f2-e54342049c1d",
    "95629042-e8e1-4892-8728-e74bb0f458f9"
  ];
  const jobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, company: true, description: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
