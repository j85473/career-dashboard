import { prisma } from '../lib/prisma';
import { externalJobAlreadyObserved, ingestExternalJob, resolveCanonicalUrl } from '../lib/jobIngestion';
import * as cheerio from 'cheerio';
import {
  ApplyRedirectResolver,
  emptyScraperCounts,
  ingestionSummaryLine,
  scraperBudgetFromEnvironment,
} from '../lib/scraperRuntime';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

let activeBrowser: { close: () => Promise<void> } | null = null;
let shutdownStarted = false;

async function shutdown(signal: 'SIGTERM' | 'SIGINT') {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(`[dejobs-scraper] ${signal} received; closing browser before exit.`);
  await activeBrowser?.close().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(signal === 'SIGTERM' ? 143 : 130);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

async function run() {
  const keyword = process.argv[2] || 'customer success';
  const initialStatus = process.argv[3] || 'pending_af';
  console.log(`Starting Dejobs scraper for keyword: ${keyword}`);

  const { launch } = await import('cloakbrowser');
  console.log("[dejobs-scraper] Launching CloakBrowser...");
  
  const browser = await launch({
    headless: true
  });
  activeBrowser = browser;
  
  try {
    const page = await browser.newPage();
    const encodedKeyword = encodeURIComponent(keyword);
    const counts = emptyScraperCounts();
    const MAX_PAGES = 5;
    const budget = scraperBudgetFromEnvironment();
    const resolver = new ApplyRedirectResolver(
      browser,
      (message) => console.log(`[dejobs-scraper] ${message}`),
    );

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (budget.expired()) {
        console.log(`[dejobs-scraper] Budget spent after ${Math.round(budget.elapsedMs() / 1000)}s; stopping before page ${pageNum}.`);
        break;
      }
      const url = `https://dejobs.org/jobs/?q=${encodedKeyword}&sort=recent&page=${pageNum}`;
      if (pageNum > 1) {
        console.log(`[dejobs-scraper] Navigating to page ${pageNum}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(5000);
      } else {
        console.log(`[dejobs-scraper] Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(`[dejobs-scraper] Waiting for results to load...`);
        await delay(5000); 
      }
      
      const bodyHtml = await page.content();
      const $ = cheerio.load(bodyHtml);
      
      const jobCards = $('a').filter((_, el) => {
          const href = $(el).attr('href');
          return !!(href && href.includes('/job/'));
      });
      console.log(`[dejobs-scraper] Found ${jobCards.length} jobs on page ${pageNum}.`);
      
      if (jobCards.length === 0) break;
      
      for (const el of jobCards.toArray()) {
        if (budget.expired()) {
          console.log(`[dejobs-scraper] Budget spent mid-page; stopping cleanly.`);
          break;
        }
        const card = $(el);
        const href = card.attr('href');
        if (!href) continue;

        const sourceListingUrl = href.startsWith('http') ? href : `https://dejobs.org${href}`;
        let finalApplyLink = sourceListingUrl;
        const title = card.find('span.text-xl').text().trim();
        const companyLocationStr = card.find('span.block.text-base').text().trim();
        const [company, location] = companyLocationStr.split(' - ').map(s => s.trim());
        const description = ""; // Dejobs cards don't have descriptions in the list view
        const sourceId = href;

        if (!title || !company) {
          continue;
        }

        // The dedupe key is the card's own href, known before any navigation.
        // Skipping here is what keeps the run inside its budget: the employer
        // URL for an already-stored job was resolved when it was first seen.
        counts.seen++;
        if (await externalJobAlreadyObserved('Dejobs', sourceId)) {
          counts.duplicates++;
          continue;
        }

        console.log(`[dejobs-scraper] Resolving dejobs link: ${finalApplyLink}`);
        finalApplyLink = await resolver.resolve(finalApplyLink);
        console.log(`[dejobs-scraper] Resolved final URL: ${finalApplyLink}`);

        const resolvedCanonicalUrl = await resolveCanonicalUrl({ company, title, url: finalApplyLink }) || finalApplyLink;
        try {
          const outcome = await ingestExternalJob({
            title,
            company,
            location,
            description,
            url: resolvedCanonicalUrl,
            sourceUrl: sourceListingUrl,
            source: 'Dejobs',
            sourceId,
            postedAt: new Date(),
          }, initialStatus);
          if (outcome === 'inserted') counts.inserted++;
          else if (outcome === 'duplicate') counts.duplicates++;
          else counts.filtered++;
        } catch (error) {
          counts.processingErrors++;
          console.error('[dejobs-scraper] Failed to persist job:', error);
        }
      }
      
      if (pageNum < MAX_PAGES) {
        // We handle navigation at the top of the loop
      }
    }

    await resolver.dispose();
    console.log(`[dejobs-scraper] Successfully scraped and added ${counts.inserted} new jobs to the database.`);
    console.log(ingestionSummaryLine(counts, budget.expired()));
  } catch (error) {
    console.error("[dejobs-scraper] Error during scraping:", error);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    if (activeBrowser === browser) activeBrowser = null;
    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
