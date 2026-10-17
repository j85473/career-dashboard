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
import { newBrowserSweep, readBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep, type BrowserSweepProgress } from './browserAtsProgress';
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
    context?: BrowserContext;
} = {}) {
    const deadline = Date.now() + (options.budgetMs ?? 4 * 60000);
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let context = options.context, ownsContext = false, visited = 0;
    const definitions = (options.platforms || BROWSER_ATS_PLATFORMS).map(p => ({ platform: p, definition: browserAtsTaskDefinition(p) }));
    const tasks = await prisma.ingestionTask.findMany({ where: { source: { in: definitions.map(d => d.definition.spec.source) }, ingestionMode: 'public-board' }, select: { source: true, lastStartedAt: true } });
    definitions.sort((a, b) => (tasks.find(t => t.source === a.definition.spec.source)?.lastStartedAt?.getTime() || 0) - (tasks.find(t => t.source === b.definition.spec.source)?.lastStartedAt?.getTime() || 0));
    try {
        for (const { platform, definition } of definitions) {
            if (stopped || Date.now() >= deadline || visited >= (options.maxProviders ?? 4))
                break;
            const claim = await claimDueIngestionTask(definition.spec);
            if (!claim)
                continue;
            visited++;
            const counters = emptyExternalIngestionCounters();
            let errorMessage: string | null = null, progress: BrowserSweepProgress | undefined, board: {
                slug: string;
                platform: string;
                failCount: number;
                lastSynchronizedAt: Date | null;
            } | null = null;
            let status: 'succeeded' | 'partial' = 'succeeded', complete = false, deferred = false;
            const check = async () => {
                if (stopped || Date.now() >= deadline)
                    throw new BrowserSweepDeferred('Bounded worker turn finished; saved progress will continue');
                if (!await checkpointIngestionTask({ taskId: claim.task.id, leaseToken: claim.leaseToken, counters, cursor: asJson({ board: board?.slug || null, page: progress?.page || null, processed: progress?.seen.length || 0 }) }))
                    throw new BrowserSweepDeferred('Public-board task lease is no longer owned');
                if (board) {
                    const allowed = await prisma.atsCompany.findFirst({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, select: { slug: true } });
                    if (!allowed)
                        throw new BrowserSweepDeferred('Board was retired; collection stopped without changing its records');
                }
                if (!await browserCollectionAllowed(platform, board?.slug))
                    throw new BrowserSweepDeferred('Waiting for operator pause or ingestion capacity');
            };
            let reader: BrowserAtsReader | undefined;
            try {
                board = await prisma.atsCompany.findFirst({ where: { platform, status: { in: ['active', 'parked'] }, nextCheckDate: { lte: new Date() } }, orderBy: [{ nextCheckDate: 'asc' }, { slug: 'asc' }], select: { slug: true, platform: true, failCount: true, lastSynchronizedAt: true } });
                if (!board)
                    continue;
                if (browserAtsBoardFromUrl(platform, board.slug) !== board.slug)
                    throw Error('Stored public-board identity failed validation');
                await check();
                const saved = await prisma.atsBrowserSweep.findUnique({ where: { slug_platform: { slug: board.slug, platform } } });
                progress = saved && saved.status !== 'succeeded' ? readBrowserSweep(saved.cursor, platform, board.slug) : newBrowserSweep(board.slug);
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
                while (Date.now() < deadline && !stopped) {
                    await check();
                    if (!progress.loaded) {
                        counters.requests = (counters.requests || 0) + 1;
                        const listing = platform === 'adp' ? await adpListing(board.slug, progress.page) : await reader!.page(platform, board.slug, progress.page, progress.pageUrl);
                        if (!listing.links.length && (progress.page > 1 || !progress.seen.length && !board.lastSynchronizedAt))
                            throw Error('An empty page cannot validate a new employer or exhaust an advertised next page');
                        progress = loadBrowserSweepPage(progress, listing);
                        await saveProgress(claim, platform, board.slug, progress, 'running');
                        await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { lastRespondedAt: new Date() } });
                    }
                    while (progress.offset < progress.queue.length && processed < (options.maxJobs ?? 10)) {
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
                                else
                                    countExternalIngestionOutcome(counters, await ingestExternalJob({ ...detail, source, sourceId, ingestionMode: definition.spec.ingestionMode, taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd }));
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
                    const next = advanceBrowserSweep(progress);
                    if (!next) {
                        complete = true;
                        await saveProgress(claim, platform, board.slug, progress, 'succeeded');
                        const now = new Date();
                        await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { status: 'active', jobsFound: progress.seen.length, failCount: 0, lastCheckedAt: now, lastSynchronizedAt: now, lastProcessedAt: now, nextCheckDate: new Date(now.getTime() + 7 * 86400000) } });
                        break;
                    }
                    progress = next;
                    await saveProgress(claim, platform, board.slug, progress, 'running');
                    if (processed >= (options.maxJobs ?? 10))
                        break;
                }
                if (!complete) {
                    status = 'partial';
                    await saveProgress(claim, platform, board.slug, progress, 'partial');
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { nextCheckDate: new Date(Date.now() + 60000) } });
                }
            }
            catch (error) {
                status = 'partial';
                deferred = error instanceof BrowserSweepDeferred;
                errorMessage = error instanceof Error ? error.message : String(error);
                if (/session limit|license seat|license.*(?:expired|invalid)/i.test(errorMessage)) {
                    deferred = true;
                    stopped = true;
                }
                if (!deferred)
                    counters.providerErrors++;
                if (progress && board)
                    await saveProgress(claim, platform, board.slug, progress, 'partial', errorMessage).catch(() => { });
                if (board && !deferred)
                    await prisma.atsCompany.updateMany({ where: { slug: board.slug, platform, status: { in: ['active', 'parked'] } }, data: { failCount: { increment: 1 }, nextCheckDate: new Date(Date.now() + Math.min(24 * 3600000, 3600000 * 2 ** Math.min(board.failCount, 4))) } });
            }
            finally {
                if (reader)
                    await reader.close();
                const owned = await prisma.ingestionTask.findFirst({ where: { id: claim.task.id, leaseToken: claim.leaseToken, status: 'running' }, select: { id: true } });
                if (owned)
                    await persistExternalIngestionSourceRun({ source: definition.spec.source, counters, context: { taskId: claim.task.id, queryFamily: 'all', geoLane: 'source_posted_location', windowStart: claim.window.windowStart, windowEnd: claim.window.windowEnd, ingestionMode: 'public-board' }, startedAt: claim.task.lastStartedAt || new Date(), status: status === 'partial' ? 'partial' : undefined, error: errorMessage });
                if (owned)
                    await completeIngestionTask({ taskId: claim.task.id, taskKey: claim.task.taskKey, leaseToken: claim.leaseToken, status, counters, cadenceMs: definition.intervalMs, retryDelayMs: definition.intervalMs, continuationDelayMs: definition.intervalMs, jitterMaxMs: 0, watermarkAt: complete ? new Date() : undefined, error: errorMessage });
                console.log(JSON.stringify({ platform, board: board?.slug, page: progress?.page, processed: progress?.seen.length || 0, complete, deferred, inserted: counters.inserted, duplicates: counters.duplicates, filtered: counters.filtered, error: errorMessage }));
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
