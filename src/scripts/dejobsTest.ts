import * as cheerio from 'cheerio';

async function test() {
  const { launch } = await import('cloakbrowser');
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = 'https://dejobs.org/jobs/?q=customer+success';
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
    const html = await page.content();
    const $ = cheerio.load(html);
    
    const firstJob = $('a').filter((_, el) => {
        const href = $(el).attr('href');
        return !!(href && href.includes('/job/'));
    }).first();
    
    console.log($.html(firstJob));

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await browser.close();
  }
}

test();
