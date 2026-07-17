import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const prefs = await prisma.userPreference.findMany();
  console.log('User Preferences:');
  for (const p of prefs) {
    console.log(`- [${p.type}] ${p.text}`);
  }

  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
    },
    select: {
      title: true,
      fitScore: true,
      fitCategory: true,
    }
  });

  console.log(`\nTotal jobs in queue: ${jobs.length}`);

  let missingScore = 0;
  const scoreBuckets = {
    '0-19': 0,
    '20-39': 0,
    '40-59': 0,
    '60-79': 0,
    '80-100': 0,
  };

  for (const job of jobs) {
    if (job.fitScore === null) {
      missingScore++;
    } else {
      const s = job.fitScore;
      if (s < 20) scoreBuckets['0-19']++;
      else if (s < 40) scoreBuckets['20-39']++;
      else if (s < 60) scoreBuckets['40-59']++;
      else if (s < 80) scoreBuckets['60-79']++;
      else scoreBuckets['80-100']++;
    }
  }

  console.log('Score distribution:');
  console.log(`Missing score: ${missingScore}`);
  for (const [bucket, count] of Object.entries(scoreBuckets)) {
    console.log(`Score ${bucket}: ${count}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
