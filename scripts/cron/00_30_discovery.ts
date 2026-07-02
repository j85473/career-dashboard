import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

async function run() {
  console.log("=== STARTING ATS DISCOVERY (00:30) ===");
  try {
    const res = await fetch('http://100.80.154.113:3000/api/ats-companies/discover', { method: 'POST' });
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
