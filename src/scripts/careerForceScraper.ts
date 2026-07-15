export {};
import { prisma } from '../lib/prisma';
import { passesPreFilter } from '../lib/jobFiltering';
import { ingestExternalJob, resolveCanonicalUrl } from '../lib/jobIngestion';
import * as cheerio from 'cheerio';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function run() {
  const keyword = process.argv[2] || 'sales';
  const initialStatus = process.argv[3] || 'pending_af';
  console.log(`Starting CareerForce scraper for keyword: ${keyword}`);

  const { launch } = await import('cloakbrowser');
  console.log("[careerforce-scraper] Launching CloakBrowser...");
  
  const browser = await launch({
    headless: true
  });
  
  try {
    const page = await browser.newPage();
    const url = 'https://careerforce.mn.gov/job-search';
    
    console.log(`[careerforce-scraper] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle' });
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
    let addedCount = 0;
    const MAX_PAGES = 5;
    
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const bodyHtml = await page.content();
      const $ = cheerio.load(bodyHtml);
      
      const jobCards = $('.job-search-result');
      console.log(`[careerforce-scraper] Found ${jobCards.length} jobs on page ${pageNum}.`);
      
      if (jobCards.length === 0) break;
      
      for (const el of jobCards.toArray()) {
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
        
        if (!passesPreFilter({ title, description, location, company, url: applyLink || url }).passes) {
          continue;
        }

        const sourceId = jvid || applyLink || `${company}-${title}`;
        const resolvedCanonicalUrl = await resolveCanonicalUrl({ company, title, url: applyLink || url }) || applyLink || url;
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
        if (outcome === 'inserted') {
          addedCount++;
        }
      }
      
      if (pageNum < MAX_PAGES) {
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
    
    console.log(`[careerforce-scraper] Successfully scraped and added ${addedCount} new jobs to the database.`);
  } catch (error) {
    console.error("[careerforce-scraper] Error during scraping:", error);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
