import 'server-only';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export async function resolveRedirectUrl(url: string): Promise<string> {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

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

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    const finalUrl = page.url();
    return finalUrl || url;
  } catch (error) {
    // Graceful fallback if Puppeteer fails for any reason
    return url;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
