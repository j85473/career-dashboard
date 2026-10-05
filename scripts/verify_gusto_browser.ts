/** Read-only smoke test: no database import, task claims, or board updates. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gustoBoardSlugFromUrl, parseGustoBoardSnapshot, parseGustoPostingHtml } from '../src/lib/gustoBoard';
import { readRenderedGustoPage } from '../src/lib/gustoBrowserPage';

const defaults = [
  'https://jobs.gusto.com/boards/uhy-advisors-inc-7afc48c7-2022-4b12-b4fe-b1b719390d39',
  'https://jobs.gusto.com/boards/allianz-company-b7d0f082-864c-477d-a3d3-34bad3551b87',
  'https://jobs.gusto.com/boards/mod-bikes-6ef6b56a-6775-44e2-b0e1-1fed76816483',
];

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.some((url) => !gustoBoardSlugFromUrl(url))) throw new Error('Supply full public Gusto board URLs');
  const profile = await mkdtemp(path.join(tmpdir(), 'gusto-browser-verification-'));
  try {
    const { launchPersistentContext } = await import('cloakbrowser');
    const context = await launchPersistentContext({ userDataDir: profile, headless: false, humanize: true, locale: 'en-US', timezone: 'America/Chicago' });
    try {
      const page = context.pages()[0] || await context.newPage();
      for (const url of urls.length ? urls : defaults) {
        const slug = gustoBoardSlugFromUrl(url)!;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (!response?.ok()) throw new Error(`Board returned HTTP ${response?.status() ?? 'no response'}`);
        const listing = await readRenderedGustoPage(page, (html, text) => parseGustoBoardSnapshot(html, text, slug), 'Board');
        console.log(JSON.stringify({ board: url, company: listing.company, unavailableReason: listing.unavailableReason || null, postings: listing.postings.length }));
        for (const posting of listing.postings) {
          const detailResponse = await page.goto(posting.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          if (!detailResponse?.ok()) throw new Error(`Posting returned HTTP ${detailResponse?.status() ?? 'no response'}`);
          const detail = await readRenderedGustoPage(page, (html) => parseGustoPostingHtml(html, posting.url, slug), 'Posting');
          const headings = await page.getByRole('heading', { name: 'Description', exact: true }).count();
          console.log(JSON.stringify({ posting: detail.url, company: detail.company, title: detail.title, location: detail.location, descriptionCharacters: detail.description.length, descriptionHeadings: headings }));
        }
      }
    } finally { await context.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
