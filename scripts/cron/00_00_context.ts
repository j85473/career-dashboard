import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

async function run() {
  console.log("=== STARTING CONTEXT DB UPDATE (00:00) ===");
  try {
    const res = await fetch('http://100.80.154.113:3000/api/jobs/batch-context', { method: 'POST' });
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
