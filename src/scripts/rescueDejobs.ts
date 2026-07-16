import { prisma } from '../lib/prisma';
import { resolveCanonicalUrl } from '../lib/jobIngestion';

async function run() {
  const { launch } = await import('cloakbrowser');
  const browser = await launch({ headless: true });
  
  try {
    const jobsToRescue = await prisma.job.findMany({
      where: {
        OR: [
          { url: { contains: 'dejobs.org' } },
          { url: { contains: 'jobsyn.org' } },
          { canonicalUrl: { contains: 'dejobs.org' } },
          { canonicalUrl: { contains: 'jobsyn.org' } },
        ]
      }
    });

    console.log(`Found ${jobsToRescue.length} jobs to rescue.`);

    const concurrency = 5;
    
    // Worker queue pattern for better concurrency without batch stalling
    let index = 0;
    const worker = async (workerId: number) => {
      while (index < jobsToRescue.length) {
        const i = index++;
        const job = jobsToRescue[i];
        console.log(`[Worker ${workerId}] Processing job ${i + 1}/${jobsToRescue.length} (ID: ${job.id})`);
        
        const currentUrl = job.canonicalUrl || job.url;
        if (!currentUrl) continue;

        let dejobsPage;
        let finalApplyLink = currentUrl;
        
        try {
          dejobsPage = await browser.newPage();
          // Increase timeout slightly and add catch
          await dejobsPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000)); // wait for page hydration
          
          const applyBtnHref = await dejobsPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const btn = links.find(a => a.href.includes('jobsyn.org') || (a.innerText && a.innerText.toLowerCase().includes('apply now')));
            return btn ? btn.href : null;
          });

          if (applyBtnHref) {
            await dejobsPage.goto(applyBtnHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000)); // wait for potential JS redirects
            
            finalApplyLink = dejobsPage.url();
          }
        } catch (error: any) {
          console.error(`[Worker ${workerId} - Job ${job.id}] Error resolving link:`, error.message);
        } finally {
          if (dejobsPage) {
            await dejobsPage.close().catch(() => {});
          }
        }
        
        try {
          // Timeout for resolveCanonicalUrl
          const resolvedCanonicalPromise = resolveCanonicalUrl({ company: job.company, title: job.title, url: finalApplyLink });
          const timeoutPromise = new Promise<string | null>((_, reject) => setTimeout(() => reject(new Error('resolveCanonicalUrl timeout')), 10000));
          const resolvedCanonicalUrl = await Promise.race([resolvedCanonicalPromise, timeoutPromise]).catch(e => {
            console.error(`[Worker ${workerId} - Job ${job.id}] Canonical resolution error/timeout:`, e.message);
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
          console.log(`[Worker ${workerId} - Job ${job.id}] Successfully resurrected!`);
        } catch (dbError: any) {
          console.error(`[Worker ${workerId} - Job ${job.id}] DB update error:`, dbError.message);
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
