import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const recentJobs = await prisma.job.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  for (const job of recentJobs) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Title: ${job.title}`);
    console.log(`Company: ${job.company}`);
    console.log(`URL: ${job.url}`);
    console.log(`Desc Length: ${job.description?.length}`);
    console.log(`Desc Snippet: ${job.description?.substring(0, 150)}...\n`);
  }
}

run().finally(() => prisma.$disconnect());
