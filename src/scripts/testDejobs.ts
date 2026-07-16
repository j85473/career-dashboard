import { prisma } from '../lib/prisma';

async function run() {
  const { launch } = await import('cloakbrowser');
  const browser = await launch({ headless: true });
  const page = await browser.newPage();
  
  const jobsynUrl = 'https://de.jobsyn.org/04f259ea483c4467a86a35928673a5368003';
  await page.goto(jobsynUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));
  console.log('Final URL:', page.url());
  const aTags = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      href: a.href,
      text: a.innerText,
      id: a.id,
      className: a.className
    }));
  });
  console.log('Links:', aTags.filter(a => a.text.toLowerCase().includes('apply') || a.href.includes('jobsyn.org')));
  await browser.close();
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
