import { runDeepseekEvaluation } from '../lib/deepseekEvaluator';
import { runLuckyEvaluation } from '../lib/luckyEvaluator';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Starting DeepSeek Evaluation...');
  try {
    while (true) {
      const res = await runDeepseekEvaluation((msg) => console.log(msg));
      if (res.scoresProcessed === 0 && res.contextJobsProcessed === 0 && !res.contextUpdated) break;
    }
  } catch (e) {
    console.error('Error in DeepSeek:', e);
  }

  console.log('Starting Wildcard Evaluation...');
  try {
    while (true) {
      const res = await runLuckyEvaluation((msg) => console.log(msg));
      if (res.scoresProcessed === 0) break;
    }
  } catch (e) {
    console.error('Error in Wildcard:', e);
  }

  console.log('Done.');
  await prisma.$disconnect();
}

run();
