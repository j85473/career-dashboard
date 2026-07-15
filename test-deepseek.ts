import { runDeepseekEvaluation } from './src/lib/deepseekEvaluator';

async function main() {
  console.log("Running DeepSeek evaluation manually...");
  try {
    await runDeepseekEvaluation();
    console.log("Evaluation completed.");
  } catch(e) {
    console.error("Error:", e);
  }
}
main();
