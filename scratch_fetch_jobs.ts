import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      id: {
        in: [
          '9bb13ec8-604b-483b-b7bb-8f3ed0eee887',
          '9cc2d06d-c2b9-4958-bf6c-29c753be3b65',
          '9e129c91-6113-46c9-9b73-1841166ef4e9',
          'a0a12446-f5f5-42df-af80-2bedb55cc189',
          'a136532f-20a2-458e-8849-21c0f43f53e4'
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
