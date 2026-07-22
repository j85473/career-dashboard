import { prisma } from '../lib/prisma';
import { passesPreFilter } from '../lib/jobFiltering';
import { ingestExternalJob, resolveCanonicalUrl } from '../lib/jobIngestion';
import * as cheerio from 'cheerio';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function run() {
  const keyword = process.argv[2] || 'customer success';
  const initialStatus = process.argv[3] || 'pending_af';
  console.log(`Starting Dejobs scraper for keyword: ${keyword}`);

  const { launch } = await import('cloakbrowser');
  console.log("[dejobs-scraper] Launching CloakBrowser...");
  
  const browser = await launch({
    headless: true
  });
  
  try {
    const page = await browser.newPage();
    const encodedKeyword = encodeURIComponent(keyword);
    let addedCount = 0;
    const MAX_PAGES = 5;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = `https://dejobs.org/jobs/?q=${encodedKeyword}&sort=recent&page=${pageNum}`;
      if (pageNum > 1) {
        console.log(`[dejobs-scraper] Navigating to page ${pageNum}...`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await delay(5000);
      } else {
        console.log(`[dejobs-scraper] Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
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
        const card = $(el);
        const href = card.attr('href');
        if (!href) continue;
        
        let finalApplyLink = href.startsWith('http') ? href : `https://dejobs.org${href}`;
        const title = card.find('span.text-xl').text().trim();
        const companyLocationStr = card.find('span.block.text-base').text().trim();
        const [company, location] = companyLocationStr.split(' - ').map(s => s.trim());
        const description = ""; // Dejobs cards don't have descriptions in the list view
        const sourceId = href;
        
        if (!title || !company) {
          continue;
        }
        
        const filterCheck = passesPreFilter({ title, description, location, company, url: finalApplyLink });
        if (!filterCheck.passes) {
          continue;
        }

        console.log(`[dejobs-scraper] Resolving dejobs link: ${finalApplyLink}`);
        let dejobsPage;
        try {
          dejobsPage = await browser.newPage();
          await dejobsPage.goto(finalApplyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 3000)); // wait for page hydration
          
          const applyBtnHref = await dejobsPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const btn = links.find(a => a.href.includes('jobsyn.org') || (a.innerText && a.innerText.toLowerCase().includes('apply now')));
            return btn ? btn.href : null;
          });

          if (applyBtnHref) {
            console.log(`[dejobs-scraper] Found apply link, following redirect: ${applyBtnHref}`);
            await dejobsPage.goto(applyBtnHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(r => setTimeout(r, 3000)); // wait for potential JS redirects
            
            const resolvedUrl = dejobsPage.url();
            console.log(`[dejobs-scraper] Resolved final URL: ${resolvedUrl}`);
            finalApplyLink = resolvedUrl;
          } else {
            console.log(`[dejobs-scraper] Could not find apply button on dejobs page.`);
          }
        } catch (error: any) {
          console.error(`[dejobs-scraper] Error resolving dejobs link:`, error.message);
        } finally {
          if (dejobsPage) {
            await dejobsPage.close().catch(() => {});
          }
        }

        const resolvedCanonicalUrl = await resolveCanonicalUrl({ company, title, url: finalApplyLink }) || finalApplyLink;
        const outcome = await ingestExternalJob({
          title,
          company,
          location,
          description,
          url: resolvedCanonicalUrl,
          source: 'Dejobs',
          sourceId,
          postedAt: new Date(),
        }, initialStatus);
        
        if (outcome === 'inserted') {
          addedCount++;
        }
      }
      
      if (pageNum < MAX_PAGES) {
        // We handle navigation at the top of the loop
      }
    }
    
    console.log(`[dejobs-scraper] Successfully scraped and added ${addedCount} new jobs to the database.`);
  } catch (error) {
    console.error("[dejobs-scraper] Error during scraping:", error);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
