import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const jinaFailed = await prisma.job.count({
    where: {
      scoreError: { contains: 'Jina' }
    }
  });

  const allFailed = await prisma.job.count({
    where: {
      scoringStatus: 'failed'
    }
  });
  
  const jdBatchSuccessesMaybe = await prisma.job.count({
    where: {
      description: { not: null },
      // Try to estimate jobs that had a JD fetch by looking for >1000 length descriptions that came from JSearch (JSearch initially gives 252)
      source: 'JSearch',
    }
  });
  
  const jsearchFull = await prisma.job.count({
    where: {
      source: 'JSearch',
      description: { not: null },
    }
  });

  // Let's get actual examples of JSearch jobs to see if any have >500 length
  const jsearchJobs = await prisma.job.findMany({
    where: { source: 'JSearch' },
    select: { id: true, description: true },
    take: 100
  });

  let jsearchSuccess = 0;
  for (const j of jsearchJobs) {
    if (j.description && j.description.length > 500) {
      jsearchSuccess++;
    }
  }

  console.log(`Total jobs with Jina scoreError: ${jinaFailed}`);
  console.log(`Total jobs with scoringStatus = failed: ${allFailed}`);
  console.log(`Of 100 recent JSearch jobs, ${jsearchSuccess} have a description > 500 characters (implying successful fetch).`);
}

run().finally(() => prisma.$disconnect());
