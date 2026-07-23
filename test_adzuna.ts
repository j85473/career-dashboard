import "dotenv/config";
async function run() {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID || '',
    app_key: process.env.ADZUNA_APP_KEY || '',
    results_per_page: '50',
    what: 'sales',
    where: 'Minnesota',
    distance: '75',
    max_days_old: '7',
    sort_by: 'date',
    'content-type': 'application/json',
  });
  console.log(`URL: https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
  const response = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, {
    cache: 'no-store',
  });
  console.log(response.status);
  console.log(await response.text());
}
run();
