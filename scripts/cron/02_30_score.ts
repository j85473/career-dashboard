import './env';
import { scoreJobs } from '../../src/lib/jobScoring';

async function run() {
  console.log("=== STARTING LOCAL SCORING (02:30) ===");
  try {
    await scoreJobs((msg) => console.log(`[Score] ${msg}`));
    console.log(`Finished scoring jobs.`);
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
