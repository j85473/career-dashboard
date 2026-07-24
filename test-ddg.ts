import { searchNews, SafeSearchType } from 'duck-duck-scrape';

async function main() {
  try {
    const res = await searchNews("SaaS channel sales", { safeSearch: SafeSearchType.STRICT });
    console.log("Success! Found:", res.results?.length, "results.");
    console.log(res.results?.[0]);
  } catch (err) {
    console.error("Error fetching DDG:", err);
  }
}
main();
