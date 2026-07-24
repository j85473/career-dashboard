const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  console.log('Navigating...');
  await page.goto('https://www.adzuna.com/land/ad/5805858554?aztt=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODUzNzY0MDAsImlhdCI6MTc4NDc3MTYwMCwiY2kiOiJxdHNwU0RtRzhSR2NxZTdNcTBaTHdRIiwidHMiOiI5YmFjNDRkMyIsInR0IjoiYXBpIn0.d6ouj-pzn3bqjELzQ6xqCLsybOg5B6j89eddnv-HdB8&from_adp=1&v=F386E70F7DDCAA5388E3FA99E8D3672F11CA8C79&se=', { waitUntil: 'networkidle2', timeout: 20000 });
  
  console.log('Final URL:', page.url());
  await browser.close();
}
main().catch(console.error);
