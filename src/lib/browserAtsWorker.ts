import { nextCrawlBoard, nextCrawlRefreshAt } from './atsCrawlingSchedule';
import { prisma } from './prisma';
import { Prisma } from './prismaClient';
import type { BrowserContext } from 'playwright-core';
import { BROWSER_ATS_PLATFORMS, browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserAtsTaskDefinition } from './ingestionTaskCatalog';
import { claimDueIngestionTask, checkpointIngestionTask, completeIngestionTask, type ClaimedIngestionTask } from './ingestionControl';
import { countExternalIngestionOutcome, emptyExternalIngestionCounters, ingestExternalJob, persistExternalIngestionSourceRun } from './jobIngestion';
import { firstCollectionHealth } from './atsFirstCollectionAdmission';
import { BrowserAtsReader, adpListing, adpDetail } from './browserAtsReader';
import { browserPostingSourceId } from './browserAtsPosting';
import { newBrowserSweep, readBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep, recoverBrowserSweepContinuation, type BrowserSweepProgress } from './browserAtsProgress';
export class BrowserSweepDeferred extends Error {
}
export function browserPauseActive(state: {
    schedulePaused: boolean;
    pausedUntil: Date | null;
} | null, now = new Date()): boolean { return !!state?.schedulePaused && (!state.pausedUntil || state.pausedUntil > now); }
export async function browserCollectionAllowed(platform?: string, board?: string): Promise<boolean> {
    const [state, policy] = await Promise.all([prisma.pipelineState.findUnique({ where: { id: 'global' }, select: { schedulePaused: true, pausedUntil: true } }), prisma.atsFirstCollectionPolicy.findUnique({ where: { id: 'new-providers' } })]);
    if (browserPauseActive(state) || !policy || policy.mode === 'held')
        return false;
    if (policy.mode === 'pilot' && (!platform || !board || !Array.isArray(policy.pilotBoards) || !policy.pilotBoards.includes(`${platform}::${board}`)))
        return false;
    return (await firstCollectionHealth(prisma, 25, 5242880)).healthy;
}
const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
async function saveProgress(claim: ClaimedIngestionTask, platform: BrowserAtsPlatform, slug: string, progress: BrowserSweepProgress, status = 'partial', error: string | null = null) {
    await prisma.$transaction(async (tx) => {
        const active = await tx.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running', leaseExpiresAt: { gt: new Date() } }, select: { id: true } });
        if (!active)
            throw new BrowserSweepDeferred('Public-board worker lost its task lease');
        await tx.atsBrowserSweep.upsert({ where: { slug_platform: { slug, platform } }, create: { slug, platform, cursor: asJson(progress), status, lastError: error }, update: { cursor: asJson(progress), status, lastError: error, ...(status === 'succeeded' ? { lastCompletedAt: new Date() } : {}) } });
    }, { timeout: 10000 });
}
export async function runBrowserAtsWorker(options: {
    budgetMs?: number;
    maxProviders?: number;
    maxJobs?: number;
    platforms?: BrowserAtsPlatform[];
    boards?: readonly string[];
    context?: BrowserContext;
} = {}) {
    const deadline = Date.now() + (options.budgetMs ?? 3 * 60000);
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let context = options.context, ownsContext = false, visited = 0;
    const platforms = options.platforms || BROWSER_ATS_PLATFORMS;
    const maxTurns = options.maxProviders ?? 24;
    let retries = 0;
    const cycleStart = Math.floor(Date.now() / 60000) % 10;
    try {
        while (!stopped && Date.now() < deadline && visited < maxTurns) {
            const selected = await nextCrawlBoard(platforms, cycleStart + visited, retries < Math.max(1, Math.floor(maxTurns / 10)), options.boards);
            if (!selected) break;
            const platform = selected.platform as BrowserAtsPlatform;
            const definition = browserAtsTaskDefinition(platform);
            const claim = await claimDueIngestionTask(definition.spec);
            if (!claim) { visited++; continue; }
            visited++;
            if (selected.queue === 'retry') retries++;
            const boardDeadline = Math.min(deadline, Date.now() + 60000);
            let lastSafetyCheck = 0;
            const counters = emptyExternalIngestionCounters();
            let errorMessage: string | null = null, progress: BrowserSweepProgress | undefined, board: {
                slug: string;
                platform: string;
                failCount: number;
                lastSynchronizedAt: Date | null;
            } | null = null;
            let status: 'succeeded' | 'partial' = 'succeeded', complete = false, deferred = false;
            const check = async () => {
                if (stopped || Date.now() >= boardDeadline)
                    throw new BrowserSweepDeferred('Bounded worker turn finished; saved progress will continue');
                if (Date.now() - lastSafetyCheck < 2000) return;
                if (!await checkpointIngestionTask({ taskId: claim.task.id, leaseToken: claim.leaseToken, counters, cursor: asJson({ board: board?.slug || null, page: progress?.page || null, processed: progress?.seen.length || 0 }) }))
                    throw new BrowserSweepDeferred('Public-board task lease is no longer owned');
                if (board) {
                    const allowed = await prisma.atsCompany.findFirst({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, select: { slug: true } });
                    if (!allowed)
                        throw new BrowserSweepDeferred('Board was retired; collection stopped without changing its records');
                }
                if (!await browserCollectionAllowed(platform, board?.slug))
                    throw new BrowserSweepDeferred('Waiting for operator pause or ingestion capacity');
                lastSafetyCheck = Date.now();
            };
            let reader: BrowserAtsReader | undefined;
            try {
                board = selected;
                if (!board)
                    continue;
                if (browserAtsBoardFromUrl(platform, board.slug) !== board.slug)
                    throw Error('Stored public-board identity failed validation');
                await check();
                const saved = await prisma.atsBrowserSweep.findUnique({ where: { slug_platform: { slug: board.slug, platform } } });
                const previous = saved ? readBrowserSweep(saved.cursor, platform, board.slug) : undefined;
                progress = previous && saved?.status !== 'succeeded' ? previous : { ...newBrowserSweep(board.slug), ...(previous?.lastProductiveAt ? { lastProductiveAt: previous.lastProductiveAt } : {}) };
                await saveProgress(claim, platform, board.slug, progress, 'running');
                await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { lastAttemptedAt: new Date() } });
                if (platform !== 'adp') {
                    if (!context) {
                        const profile = process.env.CLOAKBROWSER_PROFILE_DIR;
                        if (!profile)
                            throw Error('CLOAKBROWSER_PROFILE_DIR is required');
                        const { launchPersistentContext } = await import('cloakbrowser');
                        context = await launchPersistentContext({ userDataDir: profile, headless: process.env.BROWSER_ATS_HEADLESS === '1', humanize: true, locale: 'en-US', timezone: 'America/Chicago' });
                        ownsContext = true;
                    }
                    reader = new BrowserAtsReader(context, check);
                }
                let processed = 0;
                while (Date.now() < boardDeadline && !stopped) {
                    await check();
                    if (!progress.loaded) {
                        counters.requests = (counters.requests || 0) + 1;
                        const listing = platform === 'adp' ? await adpListing(board.slug, progress.page) : await reader!.page(platform, board.slug, progress.page, progress.pageUrl);
                        if (!listing.links.length && !listing.emptyVerified && (progress.page > 1 || !progress.seen.length && !board.lastSynchronizedAt))
                            throw Error('An empty page cannot validate a new employer or exhaust an advertised next page');
                        progress = loadBrowserSweepPage(progress, listing);
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                        await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { lastRespondedAt: new Date() } });
                    }
                    while (progress.offset < progress.queue.length && processed < (options.maxJobs ?? 50)) {
                        await check();
                        const link = progress.queue[progress.offset], source = definition.spec.source, sourceId = browserPostingSourceId(board.slug, link.id);
                        if (progress.seen.includes(link.id)) {
                            countExternalIngestionOutcome(counters, 'duplicate');
                        }
                        else if (/^(?:general application|join (?:our |the )?talent (?:pool|community)|open application|expression of interest)$/i.test(link.title)) {
                            countExternalIngestionOutcome(counters, 'filtered');
                        }
                        else {
                            const known = await prisma.jobSourceObservation.findUnique({ where: { source_sourceId: { source, sourceId } }, select: { sourceId: true } });
                            if (known)
                                countExternalIngestionOutcome(counters, 'duplicate');
                            else {
                                counters.requests = (counters.requests || 0) + 1;
                                const detail = platform === 'adp' ? await adpDetail(board.slug, link) : await reader!.detail(platform, board.slug, link);
                                await check();
                                if (!detail)
                                    countExternalIngestionOutcome(counters, 'filtered');
                                else {
                                    const outcome = await ingestExternalJob({ ...detail, source, sourceId, ingestionMode: definition.spec.ingestionMode, taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd });
                                    countExternalIngestionOutcome(counters, outcome);
                                    if (outcome === 'inserted') progress.lastProductiveAt = new Date().toISOString();
                                }
                            }
                        }
                        if (!progress.seen.includes(link.id))
                            progress.seen.push(link.id);
                        progress.offset++;
                        processed++;
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                    }
                    if (progress.offset < progress.queue.length)
                        break;
                    if (platform === 'paycom' && !progress.next && progress.total !== null && progress.seen.length < progress.total) {
                        // Old cursors retain every processed ID. Re-read only to
                        // restore a verified continuation on the same saved page.
                        counters.requests = (counters.requests || 0) + 1;
                        progress = recoverBrowserSweepContinuation(progress, await reader!.page(platform, board.slug, progress.page, progress.pageUrl));
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                    }
                    const next = advanceBrowserSweep(progress);
                    if (!next) {
                        complete = true;
                        await saveProgress(claim, platform, board.slug, progress, 'succeeded');
                        const now = new Date();
                        await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { status: 'active', jobsFound: progress.seen.length, failCount: 0, lastCheckedAt: now, lastSynchronizedAt: now, lastProcessedAt: now, nextCheckDate: nextCrawlRefreshAt(platform + ":" + board.slug, progress.lastProductiveAt, now).nextRunAt } });
                        break;
                    }
                    progress = next;
                    await saveProgress(claim, platform, board.slug, progress, 'running');
                    if (processed >= (options.maxJobs ?? 50))
                        break;
                }
                if (!complete) {
                    status = 'partial';
                    await saveProgress(claim, platform, board.slug, progress, 'partial');
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { nextCheckDate: new Date(Date.now() + 1000) } });
                }
            }
            catch (error) {
                status = 'partial';
                deferred = stopped || error instanceof BrowserSweepDeferred;
                errorMessage = error instanceof Error ? error.message : String(error);
                if (/Waiting for operator pause or ingestion capacity/.test(errorMessage)) stopped = true;
                if (/session limit|license seat|license.*(?:expired|invalid)/i.test(errorMessage)) {
                    deferred = true;
                    stopped = true;
                }
                if (!deferred)
                    counters.providerErrors++;
                if (progress && board)
                    await saveProgress(claim, platform, board.slug, progress, 'partial', deferred ? null : errorMessage).catch(() => { });
                if (board && !deferred)
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { failCount: { increment: 1 }, nextCheckDate: new Date(Date.now() + (/retain for weekly retry/.test(errorMessage) ? 7 * 86400000 : Math.min(24 * 3600000, 3600000 * 2 ** Math.min(board.failCount, 4)))) } });
            }
            finally {
                if (reader)
                    await reader.close();
                const owned = await prisma.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running' }, select: { id: true } });
                if (owned)
                    await persistExternalIngestionSourceRun({ checkpoint: { crawlQueue: selected.queue, board: board?.slug || null, complete, deferred, processed: progress?.seen.length || 0 }, source: definition.spec.source, counters, context: { taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd, ingestionMode: 'public-board' }, startedAt: claim.task.lastStartedAt || new Date(), status: status === 'partial' ? 'partial' : undefined, error: errorMessage });
                if (owned)
                    await completeIngestionTask({ taskId: claim.task.id, taskKey: claim.task.taskKey, leaseToken: claim.leaseToken, status, counters, cadenceMs: 0, retryDelayMs: definition.intervalMs, continuationDelayMs: 0, jitterMaxMs: 0, watermarkAt: complete ? new Date() : undefined, error: errorMessage });
                console.log(JSON.stringify({ queue: selected.queue, platform, board: board?.slug, page: progress?.page, processed: progress?.seen.length || 0, complete, deferred, inserted: counters.inserted, duplicates: counters.duplicates, filtered: counters.filtered, error: errorMessage }));
            }
        }
    }
    finally {
        if (ownsContext && context)
            await context.close();
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
    }
    return { visited };
}
