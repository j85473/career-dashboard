import { searchNews, SafeSearchType } from 'duck-duck-scrape';

async function main() {
  const q = "SaaS channel sales";
  try {
    const results = await searchNews(q, { safeSearch: SafeSearchType.STRICT });
    console.log("Found", results.results.length, "results");
    if (results.results.length > 0) {
      console.log(results.results[0]);
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
