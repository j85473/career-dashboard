import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { checkpointIngestionTask, claimDueIngestionTask, completeIngestionTask, type ClaimedIngestionTask } from '../src/lib/ingestionControl';
import { GUSTO_PAID_SEARCH_TASK_DEFINITION } from '../src/lib/ingestionTaskCatalog';
import { reconcileGustoApiBatches } from '../src/lib/gustoPaidSearch';
import {
  countExternalIngestionOutcome,
  emptyExternalIngestionCounters,
  ingestExternalJob,
  persistExternalIngestionSourceRun,
} from '../src/lib/jobIngestion';
import {
  gustoBoardUrl,
  isGustoClosedBoardPage,
  parseGustoBoardHtml,
  parseGustoPostingHtml,
} from '../src/lib/gustoBoard';

const SOURCE = 'Gusto';
// Keep posting provenance stable so already-known jobs retain their identity.
const JOB_SOURCE = 'ATS-gusto';
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

async function runGustoSweep(
  limit: number,
  claim: ClaimedIngestionTask,
  counters: ReturnType<typeof emptyExternalIngestionCounters>,
): Promise<number> {
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
    return 0;
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
  let swept = 0;
  let failed = 0;
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const board of boards) {
      if (!await checkpointIngestionTask({ taskId: claim.task.id, leaseToken: claim.leaseToken, counters })) {
        throw new Error('Gusto paid-search task lost its lease.');
      }
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
        const closed = isGustoClosedBoardPage(
          await page.locator('body').innerText(),
          (await page.locator('a[href*="/postings/"]').count()) > 0,
        );
        if (!closed) {
          await page.getByRole('heading', { name: /^(?:Open Positions|There are no open positions currently)$/i })
            .waitFor({ state: 'visible', timeout: 30_000 });
        }
        const listing = closed
          ? { company: '', postings: [] }
          : parseGustoBoardHtml(await page.content(), board.slug);
        if (!listing) throw new Error('Board did not render a valid Gusto position list');

        const existing = await prisma.jobSourceObservation.findMany({
          where: { source: JOB_SOURCE, sourceId: { in: listing.postings.map((posting) => posting.id) } },
          select: { sourceId: true },
        });
        const existingIds = new Set(existing.map((row) => row.sourceId));
        for (const posting of listing.postings) {
          if (!await checkpointIngestionTask({ taskId: claim.task.id, leaseToken: claim.leaseToken, counters })) {
            throw new Error('Gusto paid-search task lost its lease.');
          }
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
          await page.getByRole('heading', { name: 'Description', exact: true })
            .waitFor({ state: 'visible', timeout: 30_000 });
          const detail = parseGustoPostingHtml(await page.content(), posting.url, board.slug);
          if (!detail || detail.id !== posting.id) throw new Error(`Posting ${posting.id} did not render a matching Gusto description`);
          const outcome = await ingestExternalJob({
            title: detail.title,
            company: detail.company,
            description: detail.description,
            location: detail.location || posting.location,
            url: detail.url,
            source: JOB_SOURCE,
            sourceId: detail.id,
            ingestionMode: GUSTO_PAID_SEARCH_TASK_DEFINITION.spec.ingestionMode,
            taskId: claim.task.id,
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
        console.log(`[Gusto] Swept ${board.slug}: ${listing.postings.length} open posting(s)${closed ? ' (board closed; weekly recheck)' : ''}.`);
      } catch (error) {
        if (error instanceof Error && error.message === 'Gusto paid-search task lost its lease.') throw error;
        failed++;
        counters.providerErrors++;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('CloakBrowser Pro: session limit reached')) {
          // A temporarily occupied licensed seat is not evidence that any
          // particular board failed. Leave this board and the remaining batch
          // due, and let the next timer pass retry them.
          console.error('[Gusto] Browser license seat unavailable; retaining due boards for the next pass.');
          break;
        }
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
      taskId: claim.task.id,
      queryFamily: 'all',
      geoLane: 'source_posted_location',
      windowStart: startedAt,
      windowEnd: new Date(),
      ingestionMode: GUSTO_PAID_SEARCH_TASK_DEFINITION.spec.ingestionMode,
    },
    startedAt,
    status: failed ? 'partial' : undefined,
    error: failed ? `${failed} board(s) retained for retry` : null,
  });
  console.log(`[Gusto] ${swept} board(s) synchronized, ${failed} retained for retry; ${counters.inserted} new job(s).`);
  if (failed) process.exitCode = 1;
  return failed;
}

async function main(): Promise<void> {
  const limit = limitFromArguments(process.argv.slice(2));
  if (!process.env.CLOAKBROWSER_PROFILE_DIR) throw new Error('CLOAKBROWSER_PROFILE_DIR is required');
  try {
    const routed = await reconcileGustoApiBatches();
    if (routed) console.log(`[Gusto] Routed ${routed} empty API batch(es) to paid-search browser collection.`);
  } catch (error) {
    // API claims already exclude Gusto. A delayed historical handoff must not stop browser collection.
    console.error(`[Gusto] API history handoff will retry: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definition = GUSTO_PAID_SEARCH_TASK_DEFINITION;
  const claim = await claimDueIngestionTask(definition.spec);
  if (!claim) {
    console.log('[Gusto] Paid-search browser task is not due or is already leased.');
    return;
  }
  const counters = emptyExternalIngestionCounters();
  let status: 'succeeded' | 'partial' | 'failed' = 'succeeded';
  let errorMessage: string | null = null;
  try {
    const failed = await runGustoSweep(limit, claim, counters);
    if (failed) {
      status = 'partial';
      errorMessage = `${failed} board(s) retained for retry`;
    }
  } catch (error) {
    status = 'failed';
    errorMessage = error instanceof Error ? error.message : String(error);
    counters.providerErrors++;
    await persistExternalIngestionSourceRun({
      source: SOURCE,
      counters,
      context: {
        taskId: claim.task.id,
        queryFamily: definition.spec.queryFamily || null,
        geoLane: definition.spec.geoLane,
        windowStart: claim.window.windowStart,
        windowEnd: claim.window.windowEnd,
        ingestionMode: definition.spec.ingestionMode,
      },
      startedAt: claim.task.lastStartedAt || new Date(),
      status: 'failed',
      error: errorMessage,
    });
    throw error;
  } finally {
    const retained = await completeIngestionTask({
      taskId: claim.task.id,
      taskKey: claim.task.taskKey,
      leaseToken: claim.leaseToken,
      status,
      counters,
      cadenceMs: definition.intervalMs,
      retryDelayMs: definition.intervalMs,
      jitterMaxMs: 0,
      watermarkAt: new Date(),
      error: errorMessage,
    });
    if (!retained) throw new Error('Gusto paid-search task lost its completion lease.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(`[Gusto] Browser worker failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
