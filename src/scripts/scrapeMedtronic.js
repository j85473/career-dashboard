const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const url = 'https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers/job/Minneapolis-Minnesota-United-States-of-America/District-Sales-Manager--Pelvic-Health--Midwest_R71596-1?source=LinkedIn';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 3000));
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.substring(0, 5000));
  await browser.close();
})();
