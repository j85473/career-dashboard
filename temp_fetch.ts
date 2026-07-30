import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const jobIds = [
    'c70ae30f-6df6-4aa1-bda0-e5c5d678557e',
    'c7723dc2-1873-4b67-9584-13d2bfcddeef',
    'c9b628c6-cb26-41af-8a06-d5c6a1240aae',
    'cad6efde-882a-4aff-8b2f-659dc4b6c7fe',
    'cc14ccbc-9a06-4701-adf4-87c1e7ad22fd'
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
