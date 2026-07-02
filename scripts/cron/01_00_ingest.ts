import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
import { ingestJobs } from '../../src/lib/jobIngestion';

async function run() {
  console.log("=== STARTING JOB INGESTION (01:00) ===");
  try {
    const count = await ingestJobs((msg) => console.log(`[Ingest] ${msg}`));
    console.log(`Ingested ${count} jobs.`);
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
