import { ApifyClient } from 'apify-client';
import "dotenv/config";
import { ingestExternalJob } from '../../src/lib/jobIngestion';

async function main() {
  console.log("Starting Apify Dice Scraper script...");
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error("APIFY_API_TOKEN environment variable is not set.");
  }

  const client = new ApifyClient({ token });

  const input = {
    "employment_type": [
        "FULLTIME"
    ],
    "job_entries": 1000,
    "keyword": "sales",
    "location": "55405",
    "posted_date": "ANY",
    "radius": 50,
    "unit": "mi"
  };

  console.log("Starting actor run for worldunboxer/dice-jobs-scraper...");
  
  // Run the Actor and wait for it to finish
  const run = await client.actor("worldunboxer/dice-jobs-scraper").call(input);
  
  console.log(`Actor finished with status: ${run.status}. Fetching items...`);

  // Fetch the results from the dataset
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  
  console.log(`Fetched ${items.length} items from the dataset.`);
  
  if (items.length > 0) {
    console.log("Sample item structure:", JSON.stringify(items[0], null, 2));
  }
  
  let inserted = 0;
  let duplicates = 0;
  let filtered = 0;
  let errors = 0;

  for (const item of items) {
    try {
      // Cast the item to any to extract fields
      const jobItem = item as any;
      
      const title = jobItem.title || "Unknown Title";
      const company = jobItem.company || "Unknown Company";
      const location = jobItem.location || "Unknown Location";
      const description = jobItem.summary || "";
      const url = jobItem.details_page_url || "";
      const sourceId = jobItem.job_id || jobItem.guid || url;
      
      let postedAt: Date | undefined = undefined;
      if (jobItem.posted_date) {
        const parsed = new Date(jobItem.posted_date);
        if (!Number.isNaN(parsed.getTime())) {
          postedAt = parsed;
        }
      }

      const outcome = await ingestExternalJob({
        title,
        company,
        description,
        location,
        url,
        source: 'Dice',
        sourceId,
        postedAt
      }, 'inbox');

      if (outcome === 'inserted') inserted++;
      else if (outcome === 'duplicate') duplicates++;
      else if (outcome === 'filtered') filtered++;
    } catch (error) {
      console.error(`Error ingesting job: ${error instanceof Error ? error.message : String(error)}`);
      errors++;
    }
  }

  console.log(`Ingestion complete!`);
  console.log(`Results: ${inserted} inserted, ${duplicates} duplicates, ${filtered} filtered, ${errors} errors.`);
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
