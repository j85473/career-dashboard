import { nextCrawlBoard, nextCrawlRefreshAt } from './atsCrawlingSchedule';
import { prisma } from './prisma';
import { Prisma } from './prismaClient';
import type { BrowserContext } from 'playwright-core';
import { BROWSER_ATS_PLATFORMS, PUBLIC_ATS_HTTP_PLATFORMS, browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserAtsTaskDefinition } from './ingestionTaskCatalog';
import { claimDueIngestionTask, checkpointIngestionTask, completeIngestionTask, type ClaimedIngestionTask } from './ingestionControl';
import { countExternalIngestionOutcome, emptyExternalIngestionCounters, ingestExternalJob, persistExternalIngestionSourceRun } from './jobIngestion';
import { firstCollectionHealth } from './atsFirstCollectionAdmission';
import { BrowserAtsReader, adpListing, adpDetail } from './browserAtsReader';
import { browserPostingSourceId, type BrowserPostingLink } from './browserAtsPosting';
import { BrowserAtsHttpReader, canUseBrowserAtsHttp } from './browserAtsHttp';
import { previewBrowserAtsListingTitle } from './browserAtsListingFilter';
import { recordBrowserListingRejection } from './browserAtsListingEvidence';
import { newBrowserSweep, readBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep, recoverBrowserSweepContinuation, recoverTaleoBrowserSweepPage, type BrowserSweepProgress } from './browserAtsProgress';
export class BrowserSweepDeferred extends Error {
    constructor(message: string, readonly budgetReached = false) { super(message); }
}
export function browserTurnYieldAt(error: unknown, stopped: boolean, now = new Date()): Date | null {
    return !stopped && error instanceof BrowserSweepDeferred && error.budgetReached ? new Date(now.getTime() + 1000) : null;
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
async function saveProgress(claim: ClaimedIngestionTask, platform: BrowserAtsPlatform, slug: string, progress: BrowserSweepProgress, status = 'partial', error: string | null = null, yieldAt: Date | null = null) {
    await prisma.$transaction(async (tx) => {
        const active = await tx.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running', leaseExpiresAt: { gt: new Date() } }, select: { id: true } });
        if (!active)
            throw new BrowserSweepDeferred('Public-board worker lost its task lease');
        await tx.atsBrowserSweep.upsert({ where: { slug_platform: { slug, platform } }, create: { slug, platform, cursor: asJson(progress), status, lastError: error }, update: { cursor: asJson(progress), status, lastError: error, ...(status === 'succeeded' ? { lastCompletedAt: new Date() } : {}) } });
        if (yieldAt)
            await tx.atsCompany.updateMany({ where: { slug, platform, status: { in: ['active', 'parked'] } }, data: { nextCheckDate: yieldAt } });
    }, { timeout: 10000 });
}
export async function runBrowserAtsWorker(options: {
    budgetMs?: number;
    maxProviders?: number;
    maxJobs?: number;
    platforms?: BrowserAtsPlatform[];
    boards?: readonly string[];
    context?: BrowserContext;
    browserAllowed?: boolean;
} = {}) {
    const platforms = options.platforms || BROWSER_ATS_PLATFORMS;
    if (options.browserAllowed === false && platforms.some(platform => !PUBLIC_ATS_HTTP_PLATFORMS.includes(platform)))
        throw Error('HTTP-only collection cannot claim boards that may require a browser');
    const deadline = Date.now() + (options.budgetMs ?? 3 * 60000);
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let context = options.context, ownsContext = false, visited = 0;
    const maxTurns = options.maxProviders ?? 24;
    let retries = 0;
    const unavailablePlatforms = new Set<BrowserAtsPlatform>();
    const cycleStart = Math.floor(Date.now() / 60000) % 10;
    try {
        while (!stopped && Date.now() < deadline && visited < maxTurns) {
            const selected = await nextCrawlBoard(platforms.filter(p => !unavailablePlatforms.has(p)), cycleStart + visited, retries < Math.max(1, Math.floor(maxTurns / 10)), options.boards);
            if (!selected) break;
            const platform = selected.platform as BrowserAtsPlatform;
            const definition = browserAtsTaskDefinition(platform);
            const claim = await claimDueIngestionTask(definition.spec);
            if (!claim) { unavailablePlatforms.add(platform); visited++; continue; }
            visited++;
            if (selected.queue === 'retry') retries++;
            const boardDeadline = Math.min(deadline, Date.now() + 60000);
            let lastSafetyCheck = 0;
            const counters = emptyExternalIngestionCounters();
            const cost = { listingMs: 0, detailMs: 0, ingestionMs: 0, httpListings: 0, httpDetails: 0, browserListings: 0, browserDetails: 0, knownBeforeDetail: 0, titleRejectedBeforeDetail: 0 };
            const timed = async <T>(key: 'listingMs' | 'detailMs' | 'ingestionMs', action: () => Promise<T>): Promise<T> => {
                const started = Date.now();
                try { return await action(); } finally { cost[key] += Date.now() - started; }
            };
            let errorMessage: string | null = null, progress: BrowserSweepProgress | undefined, board: {
                slug: string;
                platform: string;
                failCount: number;
                lastSynchronizedAt: Date | null;
                checkDay: number;
            } | null = null;
            let status: 'succeeded' | 'partial' = 'succeeded', complete = false, deferred = false;
            const check = async () => {
                if (stopped)
                    throw new BrowserSweepDeferred('Worker stopped; saved progress will continue');
                if (Date.now() >= boardDeadline)
                    throw new BrowserSweepDeferred('Bounded worker turn finished; saved progress will continue', true);
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
            let httpDetailsAvailable = true;
            const httpReader = new BrowserAtsHttpReader(check);
            const getReader = async () => {
                if (options.browserAllowed === false) throw new BrowserSweepDeferred('HTTP-only worker cannot launch a browser');
                if (!context) {
                    const profile = process.env.CLOAKBROWSER_PROFILE_DIR;
                    if (!profile) throw Error('CLOAKBROWSER_PROFILE_DIR is required');
                    const { launchPersistentContext } = await import('cloakbrowser');
                    context = await launchPersistentContext({ userDataDir: profile, headless: process.env.BROWSER_ATS_HEADLESS === '1', humanize: true, locale: 'en-US', timezone: 'America/Chicago' });
                    ownsContext = true;
                }
                return reader ||= new BrowserAtsReader(context, check);
            };
            const readListing = () => timed('listingMs', async () => {
                if (platform === 'adp') { cost.httpListings++; return adpListing(board!.slug, progress!.page); }
                // Old browser page numbers must not be reinterpreted as a new
                // HTTP cursor. Exact posting details can still use HTTP safely.
                if (!progress!.transport && (progress!.page > 1 || progress!.loaded || progress!.seen.length > 0)) progress!.transport = 'browser-v1';
                if (canUseBrowserAtsHttp(platform) && progress!.transport !== 'browser-v1') {
                    const listing = await httpReader.page(platform, board!.slug, progress!.page, progress!.pageUrl);
                    if (listing) { cost.httpListings++; progress!.transport = 'http-v1'; return listing; }
                    if (progress!.transport === 'http-v1') throw Error('Public HTTP listing unavailable; preserving its exact traversal for retry');
                    httpDetailsAvailable = false;
                }
                progress!.transport = 'browser-v1';
                cost.browserListings++;
                return (await getReader()).page(platform, board!.slug, progress!.page, progress!.pageUrl);
            });
            const readDetail = (link: BrowserPostingLink) => timed('detailMs', async () => {
                if (platform === 'adp') { cost.httpDetails++; return adpDetail(board!.slug, link); }
                if (canUseBrowserAtsHttp(platform) && httpDetailsAvailable) {
                    const detail = await httpReader.detail(platform, board!.slug, link);
                    if (detail) { cost.httpDetails++; return detail; }
                    // One unsupported/challenged tenant must not pay the HTTP
                    // timeout again for every remaining posting in this turn.
                    httpDetailsAvailable = false;
                }
                cost.browserDetails++;
                return (await getReader()).detail(platform, board!.slug, link);
            });
            try {
                // A weekly reservation can commit between selection and the
                // task claim. The lease now fences that planner; re-read the
                // due date and weekday before starting any board work.
                board = await prisma.atsCompany.findFirst({
                    where: { slug: selected.slug, platform, status: { in: ['active', 'parked'] }, nextCheckDate: { lte: new Date() } },
                    select: { slug: true, platform: true, checkDay: true, failCount: true, lastSynchronizedAt: true },
                });
                if (!board) throw new BrowserSweepDeferred('Board received a future slot before claim; preserving its current schedule');
                if (browserAtsBoardFromUrl(platform, board.slug) !== board.slug)
                    throw Error('Stored public-board identity failed validation');
                await check();
                const saved = await prisma.atsBrowserSweep.findUnique({ where: { slug_platform: { slug: board.slug, platform } } });
                const previous = saved ? readBrowserSweep(saved.cursor, platform, board.slug) : undefined;
                progress = previous && saved?.status !== 'succeeded' ? previous : { ...newBrowserSweep(board.slug), ...(previous?.lastProductiveAt ? { lastProductiveAt: previous.lastProductiveAt } : {}) };
                await saveProgress(claim, platform, board.slug, progress, 'running');
                await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { lastAttemptedAt: new Date() } });
                let processed = 0;
                while (Date.now() < boardDeadline && !stopped) {
                    await check();
                    if (!progress.loaded) {
                        counters.requests = (counters.requests || 0) + 1;
                        const listing = await readListing();
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
                        else {
                            const known = await prisma.jobSourceObservation.findUnique({ where: { source_sourceId: { source, sourceId } }, select: { sourceId: true } });
                            const titleDecision = previewBrowserAtsListingTitle({ title: link.title, titleComplete: link.titleVerified === true });
                            const existingGeneric = /^(?:general application|join (?:our |the )?talent (?:pool|community)|open application|expression of interest)$/i.test(link.title);
                            if (known) {
                                cost.knownBeforeDetail++;
                                countExternalIngestionOutcome(counters, 'duplicate');
                            } else if (existingGeneric || titleDecision.wouldSkip) {
                                const reason = titleDecision.reason || 'Generic application listing rejected';
                                await recordBrowserListingRejection({ taskId: claim.task.id, source, sourceId, board: board.slug, platform, link, reason });
                                cost.titleRejectedBeforeDetail++;
                                countExternalIngestionOutcome(counters, 'filtered');
                            } else {
                                counters.requests = (counters.requests || 0) + 1;
                                const detail = await readDetail(link);
                                await check();
                                if (!detail)
                                    countExternalIngestionOutcome(counters, 'filtered');
                                else {
                                    const outcome = await timed('ingestionMs', () => ingestExternalJob({ ...detail, source, sourceId, ingestionMode: definition.spec.ingestionMode, taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd }));
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
                    if ((platform === 'paycom' || platform === 'brassring' || platform === 'taleo') && !progress.next && !progress.terminal && progress.total !== null && progress.seen.length < progress.total) {
                        // Old cursors retain every processed ID. Re-read only to
                        // restore a verified continuation on the same saved page.
                        counters.requests = (counters.requests || 0) + 1;
                        const listing = await readListing();
                        progress = platform === 'taleo' ? recoverTaleoBrowserSweepPage(progress, listing) : recoverBrowserSweepContinuation(progress, listing);
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                        if (progress.offset < progress.queue.length) {
                            if (processed >= (options.maxJobs ?? 50)) break;
                            continue;
                        }
                    }
                    const next = advanceBrowserSweep(progress);
                    if (!next) {
                        complete = true;
                        await saveProgress(claim, platform, board.slug, progress, 'succeeded');
                        const now = new Date();
                        await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { status: 'active', jobsFound: progress.seen.length, failCount: 0, lastCheckedAt: now, lastSynchronizedAt: now, lastProcessedAt: now, nextCheckDate: nextCrawlRefreshAt(platform + ":" + board.slug, progress.lastProductiveAt, now, board.checkDay).nextRunAt } });
                        break;
                    }
                    progress = next;
                    await saveProgress(claim, platform, board.slug, progress, 'running');
                    if (processed >= (options.maxJobs ?? 50))
                        break;
                }
                if (!complete) {
                    status = 'partial';
                    await saveProgress(claim, platform, board.slug, progress, 'partial', null, stopped ? null : new Date(Date.now() + 1000));
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
                    await saveProgress(claim, platform, board.slug, progress, 'partial', deferred ? null : errorMessage, browserTurnYieldAt(error, stopped)).catch(() => { });
                if (board && !deferred)
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { failCount: { increment: 1 }, nextCheckDate: new Date(Date.now() + (/retain for weekly retry/.test(errorMessage) ? 7 * 86400000 : Math.min(24 * 3600000, 3600000 * 2 ** Math.min(board.failCount, 4)))) } });
            }
            finally {
                if (reader)
                    await reader.close();
                const owned = await prisma.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running' }, select: { id: true } });
                if (owned)
                    await persistExternalIngestionSourceRun({ checkpoint: { crawlQueue: selected.queue, board: board?.slug || null, complete, deferred, processed: progress?.seen.length || 0, cost, ...(progress?.terminal ? { terminal: asJson(progress.terminal), advertisedTotal: progress.total } : {}) }, source: definition.spec.source, counters, context: { taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd, ingestionMode: 'public-board' }, startedAt: claim.task.lastStartedAt || new Date(), status: status === 'partial' ? 'partial' : undefined, error: errorMessage });
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
