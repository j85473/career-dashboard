import { runDeepseekEvaluation } from '../lib/deepseekEvaluator';
import { runLuckyEvaluation } from '../lib/luckyEvaluator';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log('Starting DeepSeek Evaluation...');
  let deepseekBackoff = 1000;
  
  while (true) {
    try {
      const res = await runDeepseekEvaluation((msg) => console.log(msg));
      if (res.scoresProcessed === 0 && res.contextJobsProcessed === 0 && !res.contextUpdated && (res.staleClaimsReleased === undefined || res.staleClaimsReleased === 0)) break;
      deepseekBackoff = 1000; // Reset backoff on success
    } catch (e) {
      console.error('Error in DeepSeek:', e);
      console.log(`Waiting ${deepseekBackoff}ms before retrying DeepSeek...`);
      await sleep(deepseekBackoff);
      deepseekBackoff = Math.min(deepseekBackoff * 2, 60000);
    }
  }

  console.log('Starting Wildcard Evaluation...');
  let wildcardBackoff = 1000;
  
  while (true) {
    try {
      const res = await runLuckyEvaluation((msg) => console.log(msg));
      if (res.scoresProcessed === 0) break;
      wildcardBackoff = 1000; // Reset backoff on success
    } catch (e) {
      console.error('Error in Wildcard:', e);
      console.log(`Waiting ${wildcardBackoff}ms before retrying Wildcard...`);
      await sleep(wildcardBackoff);
      wildcardBackoff = Math.min(wildcardBackoff * 2, 60000);
    }
  }

  console.log('Done.');
  await prisma.$disconnect();
}

run();
