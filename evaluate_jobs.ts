import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      id: {
        in: [
          '431232be-9690-4da1-b804-bae8f12016d7',
          '433d40de-5ee4-415b-a89c-59695aaa0d8e',
          '4347769a-b223-472e-8bcb-b6ec666b45e1',
          '4a57d7ab-33f6-475a-831f-9f45c095e6ca',
          '4b94bc55-6b4d-4030-b945-a73a7de90d16'
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
