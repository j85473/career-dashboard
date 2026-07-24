const fs = require('fs');
require('dotenv').config({path: '.env'});
const adzunaAppId = process.env.ADZUNA_APP_ID;
const adzunaAppKey = process.env.ADZUNA_APP_KEY;

async function main() {
  const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${adzunaAppId}&app_key=${adzunaAppKey}&results_per_page=1&what=sales`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(JSON.stringify(data.results[0], null, 2));
}
main().catch(console.error);
