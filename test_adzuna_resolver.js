const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  // Go to the Adzuna job page
  console.log('Navigating to Adzuna job page...');
  await page.goto('https://www.adzuna.com/details/5805858554?utm_medium=api&utm_source=9bac44d3', { waitUntil: 'networkidle2' });
  
  // Find the land/ad link
  console.log('Extracting apply link...');
  const html = await page.content();
  const match = html.match(/href="(https:\/\/www\.adzuna\.com\/land\/ad\/5805858554[^"]+)"/);
  
  if (match) {
    const applyLink = match[1].replace(/&amp;/g, '&');
    console.log('Found apply link:', applyLink);
    
    console.log('Following apply link...');
    await page.goto(applyLink, { waitUntil: 'networkidle2', timeout: 15000 });
    console.log('Final URL after clicking apply link:', page.url());
  } else {
    console.log('No apply link found!');
  }
  
  await browser.close();
}
main().catch(console.error);
