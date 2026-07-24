require('dotenv').config({path: '.env'});
const adzunaAppId = process.env.ADZUNA_APP_ID;
const adzunaAppKey = process.env.ADZUNA_APP_KEY;

async function main() {
  const url = `https://api.adzuna.com/v1/api/jobs/us/details/5805858554?app_id=${adzunaAppId}&app_key=${adzunaAppKey}`;
  const res = await fetch(url);
  console.log('Status:', res.status);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
main().catch(console.error);
