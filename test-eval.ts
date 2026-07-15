import { runDeepseekEvaluation } from './src/lib/deepseekEvaluator';
import { prisma } from './src/lib/prisma';

async function test() {
  console.log("Testing evaluation script directly...");
  try {
    const res = await runDeepseekEvaluation(console.log);
    console.log("Evaluation result:", res);
  } catch (e) {
    console.error("Evaluation threw:", e);
  }
}

test().finally(() => prisma.$disconnect());
