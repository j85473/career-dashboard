import 'dotenv/config';

async function testApify() {
  const apiToken = process.env.APIFY_API_TOKEN;
  const actorId = 'harvestapi~linkedin-profile-search';
  const apiUrl = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items`;

  console.log(`Fetching from ${apiUrl}`);
  
  const response = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!response.ok) {
    console.error(`Apify outreach API error: HTTP ${response.status}`);
    const text = await response.text();
    console.error(text);
    return;
  }

  const items = await response.json();
  console.log(`Received ${items.length} items`);
  if (items.length > 0) {
    console.log('First item:', JSON.stringify(items[0], null, 2));
  }
}

testApify().catch(console.error);
