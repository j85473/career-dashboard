import 'dotenv/config';
const apiUrl = 'https://api.apify.com/v2/acts/cheap_scraper~linkedin-job-scraper/runs/last/dataset/items';
fetch(apiUrl, { headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` } })
  .then(res => res.json())
  .then(items => {
    if (items.length > 0) {
      console.log(JSON.stringify(items[0], null, 2));
    } else {
      console.log("No items found");
    }
  })
  .catch(console.error);
