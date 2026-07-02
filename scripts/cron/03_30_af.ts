import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

async function run() {
  console.log("=== STARTING AIM FIT BATCH (03:30) ===");
  try {
    const res = await fetch('http://REDACTED_IP:3000/api/jobs/batch-af', { method: 'POST' });
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
