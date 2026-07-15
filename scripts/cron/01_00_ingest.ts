import './env';
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
