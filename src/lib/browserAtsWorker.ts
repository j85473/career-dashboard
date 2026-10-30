import { setTimeout as delay } from 'node:timers/promises';
import { crawlTimeOrder } from './crawlTimeBudget';
import { nextCrawlBoard, nextCrawlRefreshAt } from './atsCrawlingSchedule';
import { prisma } from './prisma';
import { Prisma } from './prismaClient';
import type { BrowserContext } from 'playwright-core';
import { publicAtsWorkerPlatforms, browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserAtsTaskDefinition } from './ingestionTaskCatalog';
import { claimDueIngestionTask, checkpointIngestionTask, completeIngestionTask, type ClaimedIngestionTask } from './ingestionControl';
import { countExternalIngestionOutcome, emptyExternalIngestionCounters, externalJobAlreadyObserved, ingestExternalJob, persistExternalIngestionSourceRun } from './jobIngestion';
import { publicCrawlCapacity } from './publicCrawlCapacity';
import { BrowserAtsReader, adpListing, adpDetail } from './browserAtsReader';
import { BrowserPostingEvidenceError, browserPostingSourceId, type BrowserPostingLink } from './browserAtsPosting';
import { BrowserAtsHttpReader } from './browserAtsHttp';
import { previewBrowserAtsListingTitle } from './browserAtsListingFilter';
import { recordBrowserListingRejection } from './browserAtsListingEvidence';
import { newBrowserSweep, readBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep, recoverBrowserSweepContinuation, recoverTaleoBrowserSweepPage, retryBrowserSweepDetails, readBrowserSweepDetail, type BrowserSweepProgress } from './browserAtsProgress';
import { BrowserSweepDeferred, BrowserAtsHttpHandoff, crawlLaneCheckpoint, publicCrawlLaneAllows } from './browserAtsTransport';
import { PublicCrawlReader } from './browserAtsTransportReader';
import { browserCrawlRetry } from './browserAtsRetry';
export { BrowserSweepDeferred, BrowserAtsHttpHandoff } from './browserAtsTransport';
export function browserTurnYieldAt(error: unknown, stopped: boolean, now = new Date()): Date | null {
    return !stopped && error instanceof BrowserSweepDeferred && error.budgetReached ? new Date(now.getTime() + 1000) : null;
}
/** A timed-out Taleo replay is a board retry, not a productive continuation.
 * Keep every cursor field intact and let the existing board backoff give other
 * work a turn. Pauses, shutdowns and lease/capacity deferrals keep their meaning. */
export function taleoTurnError(error: unknown, stopped: boolean, before?: BrowserSweepProgress, after?: BrowserSweepProgress): unknown {
    const position = (p: BrowserSweepProgress) => JSON.stringify([p.page, p.loaded, p.offset, p.queue, p.seen, p.signatures, p.next]);
    if (!stopped && error instanceof BrowserSweepDeferred && error.budgetReached && before && after && position(before) === position(after))
        return Error('Taleo turn exhausted its time budget without advancing saved progress; retaining cursor for retry');
    return error;
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
    return (await publicCrawlCapacity(prisma)).healthy;
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
    const platforms = options.platforms || publicAtsWorkerPlatforms(options.browserAllowed === false);
    if (options.browserAllowed === false && platforms.some(platform => !publicAtsWorkerPlatforms(true).includes(platform)))
        throw Error('HTTP-only collection cannot claim boards that may require a browser');
    const lane = options.browserAllowed === false ? 'http' : 'browser';
    const deadline = Date.now() + (options.budgetMs ?? 6 * 60000);
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let context = options.context, ownsContext = false, visited = 0;
    const maxTurns = options.maxProviders ?? 10000;
    const spent = { first: 0, refresh: 0, continuation: 0, retry: 0 };
    const unavailablePlatforms = new Set<BrowserAtsPlatform>();
    const cycleStart = Math.floor(Date.now() / 60000) % 10;
    try {
        while (!stopped && Date.now() < deadline && visited < maxTurns) {
            const selected = await nextCrawlBoard(platforms.filter(p => !unavailablePlatforms.has(p)), cycleStart + visited, spent.retry < (options.budgetMs ?? 6 * 60000) * 0.1, options.boards, undefined, prisma, lane, crawlTimeOrder(spent));
            if (!selected) break;
            const platform = selected.platform as BrowserAtsPlatform;
            const definition = browserAtsTaskDefinition(platform);
            const claim = await claimDueIngestionTask(definition.spec);
            if (!claim) { unavailablePlatforms.add(platform); visited++; continue; }
            const laneCursor = crawlLaneCheckpoint(claim.task.cursor, lane, claim.task.lastStartedAt || new Date());
            visited++;
            const turnStartedAt = Date.now();
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
            let initialProgress: BrowserSweepProgress | undefined;
            let retry: ReturnType<typeof browserCrawlRetry> | undefined;
            let status: 'succeeded' | 'partial' = 'succeeded', complete = false, deferred = false;
            const check = async () => {
                if (stopped)
                    throw new BrowserSweepDeferred('Worker stopped; saved progress will continue');
                if (Date.now() >= boardDeadline)
                    throw new BrowserSweepDeferred('Bounded worker turn finished; saved progress will continue', true);
                if (Date.now() - lastSafetyCheck < 2000) return;
                if (!await checkpointIngestionTask({ taskId: claim.task.id, leaseToken: claim.leaseToken, counters, cursor: asJson({ ...laneCursor, board: board?.slug || null, page: progress?.page || null, processed: progress?.seen.length || 0 }) }))
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
            const httpReader = new BrowserAtsHttpReader(check);
            let transportReader: PublicCrawlReader;
            const getReader = async () => {
                if (options.browserAllowed === false) throw new BrowserAtsHttpHandoff('listing');
                if (!context) {
                    const profile = process.env.CLOAKBROWSER_PROFILE_DIR;
                    if (!profile) throw Error('CLOAKBROWSER_PROFILE_DIR is required');
                    const { launchPersistentContext } = await import('cloakbrowser');
                    context = await launchPersistentContext({ userDataDir: profile, headless: process.env.BROWSER_ATS_HEADLESS === '1', humanize: true, locale: 'en-US', timezone: 'America/Chicago' });
                    ownsContext = true;
                }
                return reader ||= new BrowserAtsReader(context, check);
            };
            const readListing = () => timed('listingMs', () => transportReader.listing());
            const readDetail = (link: BrowserPostingLink) => timed('detailMs', () => transportReader.detail(link));
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
                if (!publicCrawlLaneAllows(platform, lane, saved && previous ? { status: saved.status, progress: previous } : undefined))
                    throw new BrowserSweepDeferred('Saved crawl changed transport ownership before claim; retaining its position');
                progress = previous && saved?.status !== 'succeeded' ? previous : { ...newBrowserSweep(board.slug), ...(previous?.lastProductiveAt ? { lastProductiveAt: previous.lastProductiveAt } : {}) };
                transportReader = new PublicCrawlReader({ platform, board: board.slug, progress: () => progress!,
                    browserAllowed: options.browserAllowed !== false, http: httpReader, browser: getReader, cost,
                    adp: { listing: adpListing, detail: adpDetail } });
                progress = retryBrowserSweepDetails(progress);
                if (platform === 'taleo') initialProgress = structuredClone(progress);
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
                            const known = await externalJobAlreadyObserved(source, sourceId);
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
                                const detail = await readBrowserSweepDetail(progress, link, () => readDetail(link));
                                if (detail === undefined) {
                                    counters.providerErrors++;
                                    progress.offset++;
                                    processed++;
                                    await saveProgress(claim, platform, board.slug, progress, 'running');
                                    continue;
                                }
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
                        if (progress.detailFailures) progress.detailFailures = progress.detailFailures.filter(f => f.id !== link.id);
                        progress.offset++;
                        processed++;
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                    }
                    if (progress.offset < progress.queue.length)
                        break;
                    if (!progress.detailFailures?.length && (platform === 'paycom' || platform === 'brassring' || platform === 'taleo') && !progress.next && !progress.terminal && progress.total !== null && progress.seen.length < progress.total) {
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
                    if (platform === 'taleo' && !stopped && Date.now() >= boardDeadline)
                        throw new BrowserSweepDeferred('Bounded worker turn finished; saved progress will continue', true);
                    status = 'partial';
                    await saveProgress(claim, platform, board.slug, progress, 'partial', null, stopped ? null : new Date(Date.now() + 1000));
                }
            }
            catch (caught) {
                const error = platform === 'taleo' ? taleoTurnError(caught, stopped, initialProgress, progress) : caught;
                status = 'partial';
                deferred = stopped || error instanceof BrowserSweepDeferred;
                errorMessage = error instanceof Error ? error.message : String(error);
                if (/Waiting for operator pause or ingestion capacity/.test(errorMessage)) stopped = true;
                if (/session limit|license seat|license.*(?:expired|invalid)/i.test(errorMessage)) {
                    deferred = true;
                    stopped = true;
                }
                if (!deferred && !(error instanceof BrowserPostingEvidenceError && error.counted))
                    counters.providerErrors++;
                if (progress && error instanceof BrowserAtsHttpHandoff)
                    progress.browserRequired = error.required;
                if (progress && board)
                    await saveProgress(claim, platform, board.slug, progress, 'partial', deferred ? null : errorMessage,
                        error instanceof BrowserAtsHttpHandoff ? null : browserTurnYieldAt(error, stopped));
                if (board && !deferred) {
                    retry = browserCrawlRetry(errorMessage, board.failCount);
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { failCount: { increment: 1 }, nextCheckDate: retry.nextRetryAt } });
                }
            }
            finally {
                spent[selected.queue] += Math.max(1, Date.now() - turnStartedAt);
                if (reader)
                    await reader.close();
                const owned = await prisma.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running' }, select: { id: true } });
                if (owned)
                    await persistExternalIngestionSourceRun({ checkpoint: { crawlQueue: selected.queue, board: board?.slug || null, complete, deferred, lane,
                        firstCollectionCompleted: complete && board?.lastSynchronizedAt === null,
                        scheduling: { queueTimeMs: { ...spent }, readyBoards: selected.readyBoards || 0, averageTurnMs: selected.averageTurnMs ?? null },
                        ...(progress?.browserRequired ? { browserRequired: progress.browserRequired } : {}),
                        ...(retry ? { retry: { kind: retry.kind, nextRetryAt: retry.nextRetryAt.toISOString() } } : {}),
                        processed: progress?.seen.length || 0, cost, ...(progress?.terminal ? { terminal: asJson(progress.terminal), advertisedTotal: progress.total } : {}) }, source: definition.spec.source, counters, context: { taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd, ingestionMode: 'public-board' }, startedAt: claim.task.lastStartedAt || new Date(), status: status === 'partial' ? 'partial' : undefined, error: errorMessage });
                if (owned)
                    await completeIngestionTask({ taskId: claim.task.id, taskKey: claim.task.taskKey, leaseToken: claim.leaseToken, status, counters, cadenceMs: 0, retryDelayMs: definition.intervalMs, continuationDelayMs: 0, jitterMaxMs: 0, watermarkAt: complete ? new Date() : undefined, error: errorMessage });
                console.log(JSON.stringify({ queue: selected.queue, platform, board: board?.slug, page: progress?.page, processed: progress?.seen.length || 0, complete, deferred, inserted: counters.inserted, duplicates: counters.duplicates, filtered: counters.filtered, error: errorMessage }));
            }
            // Bound same-group board starts even when public responses are very fast.
            if (lane === 'http' && !stopped) await delay(Math.max(0, 500 - (Date.now() - turnStartedAt)));
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
