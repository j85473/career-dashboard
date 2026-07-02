import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
import { scoreJobs } from '../../src/lib/jobScoring';

async function run() {
  console.log("=== STARTING LOCAL SCORING (02:30) ===");
  try {
    const count = await scoreJobs((msg) => console.log(`[Score] ${msg}`));
    console.log(`Finished scoring jobs.`);
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
