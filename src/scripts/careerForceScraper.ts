export {};
import { prisma } from '../lib/prisma';
import { externalJobAlreadyObserved, ingestExternalJob, resolveCanonicalUrl } from '../lib/jobIngestion';
import * as cheerio from 'cheerio';
import { urlMatchesAnyHost } from '../lib/urlHost';
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
  console.error(`[careerforce-scraper] ${signal} received; closing browser before exit.`);
  await activeBrowser?.close().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(signal === 'SIGTERM' ? 143 : 130);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

async function run() {
  const keyword = process.argv[2] || 'sales';
  const initialStatus = process.argv[3] || 'pending_af';
  console.log(`Starting CareerForce scraper for keyword: ${keyword}`);

  const { launch } = await import('cloakbrowser');
  console.log("[careerforce-scraper] Launching CloakBrowser...");
  
  const browser = await launch({
    headless: true
  });
  activeBrowser = browser;
  
  try {
    const page = await browser.newPage();
    const url = 'https://careerforce.mn.gov/job-search';
    
    console.log(`[careerforce-scraper] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2000);
    
    console.log(`[careerforce-scraper] Entering search term...`);
    await page.evaluate(() => {
      (document.getElementById('edit-title') as HTMLInputElement).value = '';
    });
    await page.type('#edit-title', keyword, { delay: 50 });
    
    console.log(`[careerforce-scraper] Setting sort order to most recent...`);
    await page.selectOption('#edit-sort', 'date-posted-desc').catch(() => {
      console.log("[careerforce-scraper] Failed to find or set sort dropdown, continuing with default sort.");
    });
    
    console.log(`[careerforce-scraper] Clicking search...`);
    await page.click('#edit-submit');
    
    // Wait for the results to load (AJAX)
    console.log(`[careerforce-scraper] Waiting for results to load...`);
    await delay(8000); 
    const counts = emptyScraperCounts();
    const MAX_PAGES = 5;
    const budget = scraperBudgetFromEnvironment();
    const resolver = new ApplyRedirectResolver(
      browser,
      (message) => console.log(`[careerforce-scraper] ${message}`),
    );

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (budget.expired()) {
        console.log(`[careerforce-scraper] Budget spent after ${Math.round(budget.elapsedMs() / 1000)}s; stopping before page ${pageNum}.`);
        break;
      }
      const bodyHtml = await page.content();
      const $ = cheerio.load(bodyHtml);

      const jobCards = $('.job-search-result');
      console.log(`[careerforce-scraper] Found ${jobCards.length} jobs on page ${pageNum}.`);

      if (jobCards.length === 0) break;

      for (const el of jobCards.toArray()) {
        if (budget.expired()) {
          console.log(`[careerforce-scraper] Budget spent mid-page; stopping cleanly.`);
          break;
        }
        const card = $(el);

        const title = card.find('h3[id$="-title"]').text().trim();
        const applyLink = card.find('a[id$="-apply"]').attr('href');
        const jvid = card.attr('data-jvid');

        const companyLocationContainer = card.find('.tw-mb-4.tw-text-gray-600.tw-text-base.tw-font-semibold');
        const spans = companyLocationContainer.find('> span');
        const company = $(spans[0]).text().trim();
        const location = $(spans[1]).text().replace('--', '').trim();

        const description = card.find('.job-description__summary').text().trim();

        if (!title || !company) continue;

        // Every field of the dedupe key is on the card, so this runs before the
        // browser work. A job we have already stored kept its real employer URL
        // from the run that first resolved it; re-resolving costs 6-8 seconds
        // and changes nothing.
        const sourceId = jvid || applyLink || `${company}-${title}`;
        counts.seen++;
        if (await externalJobAlreadyObserved('careerforce', sourceId)) {
          counts.duplicates++;
          continue;
        }

        let finalApplyLink = applyLink || url;
        if (urlMatchesAnyHost(finalApplyLink, ['dejobs.org', 'jobsyn.org'])) {
          console.log(`[careerforce-scraper] Resolving dejobs link: ${finalApplyLink}`);
          finalApplyLink = await resolver.resolve(finalApplyLink);
          console.log(`[careerforce-scraper] Resolved final URL: ${finalApplyLink}`);
        }

        const resolvedCanonicalUrl = await resolveCanonicalUrl({ company, title, url: finalApplyLink }) || finalApplyLink;
        try {
          const outcome = await ingestExternalJob({
            title,
            company,
            location,
            description,
            url: resolvedCanonicalUrl,
            source: 'careerforce',
            sourceId,
            postedAt: new Date(),
          }, initialStatus);
          if (outcome === 'inserted') counts.inserted++;
          else if (outcome === 'duplicate') counts.duplicates++;
          else counts.filtered++;
        } catch (error) {
          counts.processingErrors++;
          console.error('[careerforce-scraper] Failed to persist job:', error);
        }
      }

      if (pageNum < MAX_PAGES && !budget.expired()) {
        const hasNext = await page.$('.pager__item--next a');
        if (hasNext) {
          console.log(`[careerforce-scraper] Clicking next page...`);
          await page.click('.pager__item--next a');
          await delay(5000);
        } else {
          break;
        }
      }
    }

    await resolver.dispose();
    console.log(`[careerforce-scraper] Successfully scraped and added ${counts.inserted} new jobs to the database.`);
    console.log(ingestionSummaryLine(counts, budget.expired()));
  } catch (error) {
    console.error("[careerforce-scraper] Error during scraping:", error);
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
