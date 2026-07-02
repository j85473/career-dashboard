import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

async function run() {
  console.log("=== STARTING NEEDS JD QUEUE (01:30) ===");
  try {
    const res = await fetch('http://REDACTED_IP:3000/api/jobs/batch-jd-submit', { method: 'POST' });
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
