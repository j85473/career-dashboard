import './env';
import { ingestJobs } from '../../src/lib/jobIngestion';

async function run() {
  console.log("=== STARTING JOB INGESTION (01:00) ===");
  try {
    const primaryQueries = ['sales', 'customer success', 'customer success manager', 'channel sales', 'channel sales manager', 'distribution sales', 'distribution sales manager'];
    let totalCount = 0;
    for (const query of primaryQueries) {
      console.log(`[Ingest] Searching for: ${query}`);
      const count = await ingestJobs((msg) => console.log(`[Ingest] ${msg}`), undefined, [], query, 'inbox', true);
      totalCount += count;
    }
    console.log(`Ingested ${totalCount} jobs.`);
  } catch (e) {
    console.error("Failed:", e);
  }
}
run();
