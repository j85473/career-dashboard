import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      id: {
        in: [
          'f6ec3dbb-8cf3-4a46-8b94-2f5ba85e6c5a',
          'f7bb406d-1787-44be-bef3-c174a5916203',
          'fcacf079-d05f-4d24-8b11-404f4b4e8a56',
          'feb6e1b8-b2be-461b-b503-94c6c86ad8ed'
        ]
      }
    },
    select: {
      id: true,
      title: true,
      company: true,
      description: true
    }
  });

  console.log(JSON.stringify(jobs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
