import { ApifyClient } from 'apify-client';
import "dotenv/config";
import { ingestExternalJob } from '../../src/lib/jobIngestion';

const DICE_ACTOR = 'worldunboxer/dice-jobs-scraper';
/** The Apify schedule runs daily at 03:10; allow a wide margin before alarming. */
const MAX_DATASET_AGE_HOURS = 36;

async function main() {
  console.log("Starting Apify Dice Scraper script...");
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error("APIFY_API_TOKEN environment variable is not set.");
  }

  const client = new ApifyClient({ token });

  // READ the last run; never `.call()`. The actor is on an Apify-side schedule
  // (03:10), and `.call()` starts an additional run and bills for it — the
  // scraper was running and being paid for twice a day. Ingestion pulls
  // results; it does not commission them. The actor's input lives in the Apify
  // schedule, which is why none is passed here.
  console.log(`Reading the last succeeded run of ${DICE_ACTOR}...`);
  const lastRun = await client.actor(DICE_ACTOR).lastRun({ status: 'SUCCEEDED' }).get();
  if (!lastRun?.defaultDatasetId) {
    throw new Error(`No succeeded run found for ${DICE_ACTOR}; nothing to ingest.`);
  }

  // A stale dataset means the Apify schedule stopped firing. Re-ingesting old
  // listings would look like a healthy run and quietly hide that.
  const finishedAt = lastRun.finishedAt ? new Date(lastRun.finishedAt).getTime() : 0;
  const ageHours = finishedAt ? (Date.now() - finishedAt) / 3_600_000 : Number.POSITIVE_INFINITY;
  if (ageHours > MAX_DATASET_AGE_HOURS) {
    throw new Error(
      `${DICE_ACTOR} last succeeded ${Number.isFinite(ageHours) ? `${Math.round(ageHours)}h` : 'an unknown time'} ago; `
      + `expected a run within ${MAX_DATASET_AGE_HOURS}h. Check the Apify schedule rather than re-ingesting stale items.`,
    );
  }
  console.log(`Last run finished ${Math.round(ageHours)}h ago. Fetching items...`);

  const { items } = await client.dataset(lastRun.defaultDatasetId).listItems();
  
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
      }, 'pending_af');

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
