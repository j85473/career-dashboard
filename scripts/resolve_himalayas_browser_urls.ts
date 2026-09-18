import 'dotenv/config';

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import {
  applyDirectMatchEnrichment,
  boardIdentityFromUrl,
  planDirectMatchEnrichment,
  resolveDirectAtsPosting,
  selectDirectAtsMatch,
  type BoardPosting,
  type DirectAtsMatch,
} from '../src/lib/atsDirectMatch';
import { sameCompanyIdentity } from '../src/lib/companyIdentity';
import {
  directAtsApplyUrls,
  pagePassedCloudflare,
  rotatingCandidateIds,
  type BrowserLink,
} from '../src/lib/himalayasBrowserResolver';

type Options = { apply: boolean; limit: number };

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, limit: 8 };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (!Number.isInteger(value) || value < 1 || value > 25) throw new Error('--limit must be between 1 and 25');
      options.limit = value;
    } else {
      throw new Error('Usage: resolve_himalayas_browser_urls.ts [--apply] [--limit=N]');
    }
  }
  return options;
}

function isHimalayasListing(value: string | null | undefined): boolean {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === 'himalayas.app' || host.endsWith('.himalayas.app');
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readCursor(cursorPath: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(cursorPath, 'utf8')) as { nextOffset?: unknown };
    return Number.isInteger(value.nextOffset) && Number(value.nextOffset) >= 0 ? Number(value.nextOffset) : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursorPath: string, nextOffset: number): Promise<void> {
  const temporary = `${cursorPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ nextOffset })}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, cursorPath);
}

async function postingFromBrowserUrl(
  url: string,
  company: string,
): Promise<BoardPosting | null> {
  try {
    const scraped = await scrapeAtsApi(url);
    if (!scraped?.text || !scraped.title) return null;
    if (scraped.company && !sameCompanyIdentity(scraped.company, company)) return null;
    return {
      title: scraped.title,
      url,
      location: scraped.location || null,
      description: scraped.text,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { apply, limit } = parseArguments(process.argv.slice(2));
  const profileDirectory = process.env.CLOAKBROWSER_PROFILE_DIR;
  if (!profileDirectory) throw new Error('CLOAKBROWSER_PROFILE_DIR is required');

  const indexRows = await prisma.job.findMany({
    where: { source: { equals: 'Himalayas', mode: 'insensitive' } },
    select: { id: true, url: true, canonicalUrl: true },
    orderBy: { createdAt: 'desc' },
  });
  const unresolvedIds = indexRows.filter((job) =>
    isHimalayasListing(job.canonicalUrl || job.url)
    && !boardIdentityFromUrl(job.canonicalUrl || job.url)).map((job) => job.id);
  const cursorPath = process.env.CLOAKBROWSER_CURSOR_PATH
    || path.resolve(profileDirectory, '..', 'canonical-resolver-cursor.json');
  const cursor = await readCursor(cursorPath);
  const rotation = rotatingCandidateIds(unresolvedIds, cursor, limit);
  const rows = await prisma.job.findMany({
    where: { id: { in: rotation.ids } },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      url: true,
      canonicalUrl: true,
      source: true,
      status: true,
      updatedAt: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const jobs = rotation.ids.map((id) => byId.get(id)).filter((job): job is NonNullable<typeof job> => Boolean(job));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — inspecting ${jobs.length} of ${unresolvedIds.length} unresolved Himalayas listing(s) from cursor ${cursor}`);
  if (jobs.length === 0) return;

  // The licensed browser permits one concurrent session. One persistent
  // context processes the bounded batch serially and is owned by a dedicated
  // systemd service, so it cannot collide with existing keyless scrapers.
  const { launchPersistentContext } = await import('cloakbrowser');
  const context = await launchPersistentContext({
    userDataDir: profileDirectory,
    headless: false,
    humanize: true,
    locale: 'en-US',
    timezone: 'America/Chicago',
    args: ['--fingerprint=731942', '--fingerprint-platform=linux'],
  });

  let rendered = 0;
  let challenged = 0;
  let matched = 0;
  let written = 0;
  let stale = 0;
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const job of jobs) {
      const sourceUrl = job.canonicalUrl || job.url;
      if (!sourceUrl) continue;
      try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await delay(12_000);
        const body = await page.locator('body').innerText().catch(() => '');
        const title = await page.title().catch(() => '');
        if (!pagePassedCloudflare(body, title)) {
          challenged += 1;
          console.log(`  challenge retained: ${job.company} — ${job.title}`);
          continue;
        }
        rendered += 1;
        const links = await page.locator('a').evaluateAll((anchors: Element[]) => anchors.map((anchor) => ({
          text: (anchor.textContent || '').trim(),
          href: (anchor as HTMLAnchorElement).href,
        }))) as BrowserLink[];
        const directUrls = directAtsApplyUrls(links);

        let match: DirectAtsMatch | null = null;
        if (directUrls.length > 0) {
          const postings = (await Promise.all(directUrls.map((url) => postingFromBrowserUrl(url, job.company))))
            .filter((posting): posting is BoardPosting => posting !== null);
          const posting = selectDirectAtsMatch(job, postings);
          const board = posting ? boardIdentityFromUrl(posting.url) : null;
          if (posting && board) {
            match = {
              url: posting.url,
              description: posting.description,
              platform: board.platform,
              slug: board.slug,
              matchedVia: 'live',
              matchedBy: posting.title === job.title ? 'title' : 'description',
              postingTitle: posting.title,
              postingLocation: posting.location,
            };
          }
        }
        if (!match) {
          match = await resolveDirectAtsPosting(job, { store: prisma });
        }
        if (!match) {
          console.log(`  no proven employer posting: ${job.company} — ${job.title}`);
          continue;
        }

        const plan = planDirectMatchEnrichment(job, match);
        if (!plan) continue;
        matched += 1;
        console.log(`  ${match.matchedBy || 'title'} match: ${job.company} — ${job.title}`);
        console.log(`    ${plan.url}`);
        if (apply) {
          if (await applyDirectMatchEnrichment(job.id, job.updatedAt, plan, prisma)) written += 1;
          else stale += 1;
        }
      } catch (error) {
        console.error(`  inspection failed for ${job.company} — ${job.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (apply) await writeCursor(cursorPath, rotation.nextCursor);

  console.log(`Rendered: ${rendered}; challenged: ${challenged}; proven matches: ${matched}; written: ${written}; concurrency refusals: ${stale}`);
  if (!apply && matched > 0) console.log('Dry run only. Re-run with --apply after reviewing the proposed destinations.');
}

main()
  .catch((error: unknown) => {
    console.error(`Himalayas browser resolver failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
