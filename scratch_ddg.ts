import { search, SafeSearchType } from 'duck-duck-scrape';
async function run() {
  const query = 'site:adzuna.com/details/ "sales" "Minnesota"';
  const results = await search(query, { safeSearch: SafeSearchType.OFF });
  console.log(results.results.slice(0, 3));
}
run().catch(console.error);
