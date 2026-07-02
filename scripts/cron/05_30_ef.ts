import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

async function run() {
  console.log("=== STARTING EXPERIENCE FIT BATCH (05:30) ===");
  try {
    const res = await fetch('http://100.80.154.113:3000/api/jobs/batch-af', { method: 'POST' });
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
