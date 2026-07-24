import { searchNews, SafeSearchType } from 'duck-duck-scrape';

async function main() {
  const queries = ["SaaS channel sales", "SaaS channel sales partner programs"];
  for (const q of queries) {
     const res = await searchNews(q, { safeSearch: SafeSearchType.STRICT });
     console.log(`\nQuery: ${q}`);
     console.log("Results:", res.results?.length);
     if (res.results && res.results.length > 0) {
        console.log(res.results[0].title);
     }
  }
}
main();
