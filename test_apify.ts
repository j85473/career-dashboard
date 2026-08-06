import { ApifyClient } from 'apify-client';
import "dotenv/config";
async function main() {
  const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  const run = await client.actor("worldunboxer/adzuna-jobs-scraper").call({ keyword: "sales" });
  console.log(run);
}
main().catch(console.error);
