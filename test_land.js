const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function main() {
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
  await page.goto('https://www.adzuna.com/land/ad/5805858554', { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('Final URL:', page.url());
  await browser.close();
}
main().catch(console.error);
