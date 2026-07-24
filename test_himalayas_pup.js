const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('https://himalayas.app/companies/nextgen-healthcare/jobs/sr-specialist-i-rcm-quality-assurance', { waitUntil: 'networkidle2' });
  
  await page.screenshot({ path: 'himalayas_screenshot.png' });
  
  const content = await page.content();
  const fs = require('fs');
  fs.writeFileSync('himalayas_html.html', content);

  await browser.close();
}
run();
