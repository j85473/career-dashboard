const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://www.adzuna.com/details/5805858554?utm_medium=api&utm_source=9bac44d3', { waitUntil: 'networkidle2' });
  const html = await page.content();
  const fs = require('fs');
  fs.writeFileSync('adzuna.html', html);
  console.log('Saved to adzuna.html');
  await browser.close();
}
main().catch(console.error);
