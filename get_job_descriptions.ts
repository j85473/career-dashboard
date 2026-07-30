import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const jobIds = [
    "2b43d4c2-9d73-4fe5-8ee0-fba9402f69de",
    "2c49f2f8-16eb-4cb2-b143-19c2961a0817",
    "36ace14b-8c69-4bfb-bf7f-003c1be0f927",
    "3a4d27ac-506d-46fa-8c81-56827147e866",
    "40178296-87d4-48e2-939b-7bd0edf62236"
  ];
  const jobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, title: true, company: true, description: true, location: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
