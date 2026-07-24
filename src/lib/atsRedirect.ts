import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export async function resolveRedirectUrl(url: string, fastTimeoutMs?: number): Promise<string> {
  // Stage 1: Fast HTTP Fetch
  try {
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), fastTimeoutMs || 3000);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
    clearTimeout(fetchTimeout);

    const finalUrl = response.url;
    // If the URL changed and doesn't look like a generic redirector, return it
    if (finalUrl && finalUrl !== url && !finalUrl.includes('adzuna.com') && !finalUrl.includes('jsearch')) {
      return finalUrl;
    }
  } catch (err) {
    // Fallthrough to Stage 2 on failure
  }

  // Stage 2: Puppeteer Fallback
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

    const timeout = fastTimeoutMs ? Math.min(fastTimeoutMs + 2000, 15000) : 15000;
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    
    let finalUrl = page.url();

    // Special handling for Himalayas: extract the Apply button link
    if (url.includes('himalayas.app')) {
      const applyHref = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        const applyBtn = anchors.find(a => 
          a.innerText.toLowerCase().includes('apply') && 
          !a.href.includes('himalayas.app/companies/')
        );
        return applyBtn ? applyBtn.href : null;
      });
      if (applyHref) {
        finalUrl = applyHref;
        // Check if the apply href is just a local redirect, let's follow it if so
        if (finalUrl.includes('himalayas.app/jobs/') && finalUrl.endsWith('/apply')) {
           await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout });
           finalUrl = page.url();
        }
      }
    }

    return finalUrl || url;
  } catch (error) {
    console.error('Puppeteer resolution failed for', url, error);
    return url;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
