import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import {
  countExternalIngestionOutcome,
  emptyExternalIngestionCounters,
  ingestExternalJob,
  persistExternalIngestionSourceRun,
} from '../src/lib/jobIngestion';
import {
  gustoBoardUrl,
  parseGustoBoardHtml,
  parseGustoPostingHtml,
} from '../src/lib/gustoBoard';

const SOURCE = 'ATS-gusto';
const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

function limitFromArguments(args: string[]): number {
  if (args.length > 1 || (args[0] && !args[0].startsWith('--limit='))) {
    throw new Error('Usage: sweep_gusto_boards.ts [--limit=1..25]');
  }
  const value = args[0] ? Number(args[0].slice('--limit='.length)) : 8;
  if (!Number.isInteger(value) || value < 1 || value > 25) throw new Error('--limit must be between 1 and 25');
  return value;
}

async function main(): Promise<void> {
  const limit = limitFromArguments(process.argv.slice(2));
  const profileDirectory = process.env.CLOAKBROWSER_PROFILE_DIR;
  if (!profileDirectory) throw new Error('CLOAKBROWSER_PROFILE_DIR is required');
  const startedAt = new Date();
  const boards = await prisma.atsCompany.findMany({
    where: {
      platform: 'gusto',
      status: { in: ['active', 'parked'] },
      nextCheckDate: { lte: startedAt },
    },
    orderBy: [{ nextCheckDate: 'asc' }, { slug: 'asc' }],
    take: limit,
    select: { slug: true, failCount: true },
  });
  if (!boards.length) {
    console.log('[Gusto] No browser board sweep is due.');
    return;
  }

  const { launchPersistentContext } = await import('cloakbrowser');
  const context = await launchPersistentContext({
    userDataDir: profileDirectory,
    headless: false,
    humanize: true,
    locale: 'en-US',
    timezone: 'America/Chicago',
    args: ['--fingerprint=731942', '--fingerprint-platform=linux'],
  });
  const counters = emptyExternalIngestionCounters();
  let swept = 0;
  let failed = 0;
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const board of boards) {
      const url = gustoBoardUrl(board.slug);
      if (!url) {
        console.error(`[Gusto] Invalid stored board identity: ${board.slug}`);
        failed++;
        counters.providerErrors++;
        await prisma.atsCompany.updateMany({
          where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
          data: { failCount: { increment: 1 }, nextCheckDate: new Date(Date.now() + WEEK_MS) },
        });
        continue;
      }
      // A board may be retired while this bounded batch is waiting for its
      // turn. Excluded boards never enter the browser or the ingestion path.
      const stillAllowed = await prisma.atsCompany.findFirst({
        where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
        select: { slug: true },
      });
      if (!stillAllowed) continue;
      const attemptedAt = new Date();
      await prisma.atsCompany.updateMany({
        where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
        data: { lastAttemptedAt: attemptedAt },
      });

      try {
        counters.requests = (counters.requests || 0) + 1;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (response) {
          await prisma.atsCompany.updateMany({
            where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
            data: { lastRespondedAt: new Date() },
          });
        }
        if (!response || !response.ok()) throw new Error(`Board returned HTTP ${response?.status() ?? 'no response'}`);
        await page.locator('.job-board-header h1').first().waitFor({ state: 'visible', timeout: 30_000 });
        const listing = parseGustoBoardHtml(await page.content(), board.slug);
        if (!listing) throw new Error('Board did not render a valid Gusto position list');

        const existing = await prisma.jobSourceObservation.findMany({
          where: { source: SOURCE, sourceId: { in: listing.postings.map((posting) => posting.id) } },
          select: { sourceId: true },
        });
        const existingIds = new Set(existing.map((row) => row.sourceId));
        for (const posting of listing.postings) {
          if (existingIds.has(posting.id)) {
            countExternalIngestionOutcome(counters, 'duplicate');
            continue;
          }
          const stillActive = await prisma.atsCompany.findFirst({
            where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
            select: { slug: true },
          });
          if (!stillActive) throw new Error('Board was retired during the sweep');
          counters.requests = (counters.requests || 0) + 1;
          const postingResponse = await page.goto(posting.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          if (!postingResponse?.ok()) throw new Error(`Posting returned HTTP ${postingResponse?.status() ?? 'no response'}`);
          await page.locator('.rich-text-container').first().waitFor({ state: 'visible', timeout: 30_000 });
          const detail = parseGustoPostingHtml(await page.content(), posting.url, board.slug);
          if (!detail || detail.id !== posting.id) throw new Error(`Posting ${posting.id} did not render a matching Gusto description`);
          const outcome = await ingestExternalJob({
            title: detail.title,
            company: detail.company,
            description: detail.description,
            location: detail.location || posting.location,
            url: detail.url,
            source: SOURCE,
            sourceId: detail.id,
            ingestionMode: 'gusto_browser',
            queryFamily: 'all',
            geoLane: 'source_posted_location',
            windowStart: startedAt,
            windowEnd: new Date(),
          });
          countExternalIngestionOutcome(counters, outcome);
        }

        const synchronizedAt = new Date();
        await prisma.atsCompany.updateMany({
          where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
          data: {
            status: listing.postings.length ? 'active' : 'parked',
            jobsFound: listing.postings.length,
            failCount: 0,
            lastCheckedAt: synchronizedAt,
            lastSynchronizedAt: synchronizedAt,
            nextCheckDate: new Date(synchronizedAt.getTime() + WEEK_MS),
          },
        });
        swept++;
        console.log(`[Gusto] Swept ${board.slug}: ${listing.postings.length} open posting(s).`);
      } catch (error) {
        failed++;
        counters.providerErrors++;
        const message = error instanceof Error ? error.message : String(error);
        const retryDelay = /HTTP (?:404|410)\b/.test(message)
          ? WEEK_MS
          : Math.min(24 * HOUR_MS, HOUR_MS * 2 ** Math.min(board.failCount, 4));
        await prisma.atsCompany.updateMany({
          where: { slug: board.slug, platform: 'gusto', status: { in: ['active', 'parked'] } },
          data: { failCount: { increment: 1 }, nextCheckDate: new Date(Date.now() + retryDelay) },
        });
        console.error(`[Gusto] Retaining ${board.slug} for retry: ${message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  await persistExternalIngestionSourceRun({
    source: SOURCE,
    counters,
    context: {
      taskId: null,
      queryFamily: 'all',
      geoLane: 'source_posted_location',
      windowStart: startedAt,
      windowEnd: new Date(),
      ingestionMode: 'gusto_browser',
    },
    startedAt,
    status: failed ? 'partial' : undefined,
    error: failed ? `${failed} board(s) retained for retry` : null,
  });
  console.log(`[Gusto] ${swept} board(s) synchronized, ${failed} retained for retry; ${counters.inserted} new job(s).`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(`[Gusto] Browser worker failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
