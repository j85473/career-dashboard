import "dotenv/config";
async function run() {
  const primaryQueries = ['sales', 'customer success', 'customer success manager', 'channel sales', 'channel sales manager', 'distribution sales', 'distribution sales manager', 'strategy', 'growth', 'operations', 'founding', 'special projects'];
  for (const q of primaryQueries) {
    const params = new URLSearchParams({
      app_id: process.env.ADZUNA_APP_ID || '',
      app_key: process.env.ADZUNA_APP_KEY || '',
      results_per_page: '50',
      what: q,
      where: 'Minnesota',
      distance: '75',
      max_days_old: '7',
      sort_by: 'date',
      'content-type': 'application/json',
    });
    const res = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { cache: 'no-store' });
    console.log(`${q}: ${res.status}`);
  }
}
run();
