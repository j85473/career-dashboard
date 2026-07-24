const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function main() {
  const fs = require('fs');
  const html = fs.readFileSync('adzuna.html', 'utf8');
  const match = html.match(/href="(https:\/\/www\.adzuna\.com\/land\/ad\/5805858554[^"]+)"/);
  if (!match) return console.log('No link found');
  let fullUrl = match[1].replace(/&amp;/g, '&');
  console.log('Full URL:', fullUrl);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  console.log('Navigating...');
  await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('Final URL:', page.url());
  await browser.close();
}
main().catch(console.error);
