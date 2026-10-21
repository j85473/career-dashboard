import { Prisma } from './prismaClient';
import { PUBLIC_ATS_HTTP_FIRST_PLATFORMS, type BrowserAtsPlatform } from './browserAtsBoards';
import type { BrowserSweepProgress } from './browserAtsProgress';

export type PublicCrawlLane = 'http' | 'browser' | 'all';
/** Provider tasks are shared, but serving HTTP must not reset the browser's fairness clock. */
export function crawlLaneStart(cursor: unknown, lane: 'http' | 'browser'): Date | null {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    const starts = (cursor as Record<string, unknown>).crawlLaneStarts;
    if (!starts || typeof starts !== 'object' || Array.isArray(starts)) return null;
    const value = (starts as Record<string, unknown>)[lane];
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}
export function crawlLaneCheckpoint(cursor: unknown, lane: 'http' | 'browser', startedAt: Date): Record<string, unknown> & { crawlLaneStarts: Record<string, string> } {
    const existing = cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor as Record<string, unknown> : {};
    const starts: Record<string, string> = {};
    for (const worker of ['http', 'browser'] as const) {
        const prior = crawlLaneStart(cursor, worker);
        if (prior) starts[worker] = prior.toISOString();
    }
    starts[lane] = startedAt.toISOString();
    return { ...existing, crawlLaneStarts: starts };
}
export class BrowserSweepDeferred extends Error {
    constructor(message: string, readonly budgetReached = false) { super(message); }
}
export class BrowserAtsHttpHandoff extends BrowserSweepDeferred {
    constructor(readonly required: 'listing' | 'detail') {
        super(`Public HTTP ${required} needs browser verification; retaining the exact saved position`);
    }
}

/** A legacy browser cursor never acquires a new pagination meaning. Succeeded sweeps start fresh. */
export function browserSweepNeedsBrowser(progress: BrowserSweepProgress): boolean {
    return progress.browserRequired !== undefined || progress.transport === 'browser-v1'
        || progress.transport === undefined && (progress.page > 1 || progress.loaded || progress.seen.length > 0);
}

export function publicCrawlLaneAllows(platform: string, lane: PublicCrawlLane, sweep?: {
    status: string; progress: BrowserSweepProgress;
}): boolean {
    if (lane === 'all' || !PUBLIC_ATS_HTTP_FIRST_PLATFORMS.includes(platform as BrowserAtsPlatform)) return true;
    const needsBrowser = !!sweep && sweep.status !== 'succeeded' && browserSweepNeedsBrowser(sweep.progress);
    return lane === 'browser' ? needsBrowser : !needsBrowser;
}

/** Shares the same decision with selection. Board/task claims recheck it before any crawl mutation. */
export function publicCrawlLaneSql(lane: PublicCrawlLane): Prisma.Sql {
    if (lane === 'all') return Prisma.sql`TRUE`;
    const needsBrowser = Prisma.sql`(s.status IS NOT NULL AND s.status <> 'succeeded' AND (
        s.cursor->>'browserRequired' IS NOT NULL OR s.cursor->>'transport' = 'browser-v1'
        OR (s.cursor->>'transport' IS NULL AND (
            COALESCE(s.cursor->>'page', '1') <> '1' OR s.cursor->>'loaded' = 'true'
            OR CASE WHEN jsonb_typeof(s.cursor->'seen')='array' THEN jsonb_array_length(s.cursor->'seen') ELSE 0 END > 0
        ))))`;
    return Prisma.sql`(board.platform NOT IN (${Prisma.join([...PUBLIC_ATS_HTTP_FIRST_PLATFORMS])})
        OR ${lane === 'browser' ? needsBrowser : Prisma.sql`NOT COALESCE(${needsBrowser}, FALSE)`})`;
}
