import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function run() {
  try {
    const inboxJobs = await prisma.job.findMany({
      where: {
        OR: [
          { status: 'inbox' },
          { luckyStatus: 'inbox' }
        ]
      },
      select: {
        id: true,
        title: true,
        company: true,
        status: true,
        aimFitScore: true,
        reqFitScore: true,
        luckyStatus: true,
        luckyAimFitScore: true,
        luckyFitScore: true
      }
    });

    console.log(`Found ${inboxJobs.length} jobs in inbox or lucky inbox.`);

    const backupPath = path.join(process.cwd(), 'scores_backup.json');
    fs.writeFileSync(backupPath, JSON.stringify(inboxJobs, null, 2));
    console.log(`Saved backup to ${backupPath}`);

    // Update normal inbox jobs
    const normalResult = await prisma.job.updateMany({
      where: { status: 'inbox' },
      data: {
        aimFitScore: null,
        reqFitScore: null,
        fitCategory: 'unscored',
        scoringStatus: 'scored', // Queues it for DeepSeek
        afBatchId: null
      }
    });
    console.log(`Reset ${normalResult.count} normal inbox jobs.`);

    // Update lucky inbox jobs
    const luckyResult = await prisma.job.updateMany({
      where: { luckyStatus: 'inbox' },
      data: {
        luckyAimFitScore: null,
        luckyFitScore: null,
        luckyFitCategory: 'unscored',
        luckyStatus: 'pending', // Queues it for Wildcard evaluator
        luckyScoreAttempts: 0
      }
    });
    console.log(`Reset ${luckyResult.count} lucky inbox jobs.`);

  } catch (error) {
    console.error('Error recording and resetting:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
