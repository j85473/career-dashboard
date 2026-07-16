import { prisma } from '../lib/prisma';
import { resolveCanonicalUrl } from '../lib/jobIngestion';
import * as fs from 'fs';

async function run() {
  const startIndex = parseInt(process.argv[2], 10);
  const endIndex = parseInt(process.argv[3], 10);
  
  if (isNaN(startIndex) || isNaN(endIndex)) {
    console.log("Please provide startIndex and endIndex");
    return;
  }

  const allIds: string[] = JSON.parse(fs.readFileSync('dejobs_ids.json', 'utf8'));
  const ids = allIds.slice(startIndex, endIndex);

  if (ids.length === 0) {
    console.log("No IDs to process in this range.");
    return;
  }

  const { launch } = await import('cloakbrowser');
  const browser = await launch({ headless: true });
  
  try {
    const jobsToRescue = await prisma.job.findMany({
      where: { id: { in: ids } }
    });

    console.log(`[Batch ${startIndex}-${endIndex}] Found ${jobsToRescue.length} jobs to rescue.`);

    const concurrency = 5;
    
    // Worker queue
    let index = 0;
    const worker = async (workerId: number) => {
      while (index < jobsToRescue.length) {
        const i = index++;
        const job = jobsToRescue[i];
        
        let currentUrl = job.canonicalUrl || job.url;
        if (!currentUrl || (!currentUrl.includes('dejobs.org') && !currentUrl.includes('jobsyn.org'))) {
          continue;
        }

        let dejobsPage;
        let finalApplyLink = currentUrl;
        
        try {
          dejobsPage = await browser.newPage();
          await dejobsPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000));
          
          const applyBtnHref = await dejobsPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const btn = links.find(a => a.href.includes('jobsyn.org') || (a.innerText && a.innerText.toLowerCase().includes('apply now')));
            return btn ? btn.href : null;
          });

          if (applyBtnHref) {
            await dejobsPage.goto(applyBtnHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            finalApplyLink = dejobsPage.url();
          }
        } catch (error: any) {
          console.error(`[Job ${job.id}] Error resolving link:`, error.message);
        } finally {
          if (dejobsPage) {
            await dejobsPage.close().catch(() => {});
          }
        }
        
        try {
          const resolvedCanonicalPromise = resolveCanonicalUrl({ company: job.company, title: job.title, url: finalApplyLink });
          const timeoutPromise = new Promise<string | null>((_, reject) => setTimeout(() => reject(new Error('resolveCanonicalUrl timeout')), 10000));
          const resolvedCanonicalUrl = await Promise.race([resolvedCanonicalPromise, timeoutPromise]).catch(e => {
            return finalApplyLink;
          }) || finalApplyLink;

          await prisma.job.update({
            where: { id: job.id },
            data: {
              url: finalApplyLink,
              canonicalUrl: resolvedCanonicalUrl,
              status: 'pending_af',
              scoringStatus: 'needs_jd',
              aimFitScore: null,
              jdBatchId: null,
            }
          });
          console.log(`[Job ${job.id}] Successfully resurrected!`);
        } catch (dbError: any) {
          console.error(`[Job ${job.id}] DB update error:`, dbError.message);
        }
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker(i));
    }
    await Promise.all(workers);

  } catch (e) {
    console.error('Error during rescue operation', e);
  } finally {
    await browser.close().catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch(console.error);
