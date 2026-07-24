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

  await page.goto('https://ats.rippling.com/mastery-logistics-systems/jobs/978453c4-2849-429c-9478-14acf4183bb4?jobSite=Indeed', { waitUntil: 'networkidle2', timeout: 10000 });
  console.log('Final URL:', page.url());
  await browser.close();
}
main().catch(console.error);
