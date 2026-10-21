import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from './prismaClient';
import { prisma } from './prisma';
import { CRAWL_PENDING_DISCOVERY_SQL } from './atsCrawlingRotation';
import { publicCrawlLaneSql, type PublicCrawlLane } from './browserAtsTransport';

export type CrawlQueue = 'continuation' | 'refresh' | 'first' | 'retry';
export const CRAWL_TURN_CYCLE: readonly CrawlQueue[] = ['continuation', 'refresh', 'first', 'continuation', 'refresh', 'first', 'continuation', 'refresh', 'continuation', 'retry'];
export function crawlQueueOrder(turn: number, allowRetry: boolean): CrawlQueue[] {
  const preferred = CRAWL_TURN_CYCLE[turn % CRAWL_TURN_CYCLE.length];
  return [...new Set([preferred, 'continuation', 'refresh', 'first', 'retry'] as CrawlQueue[])].filter(q => q !== 'retry' || allowRetry);
}
export type CrawlBoard = { slug: string; platform: string; checkDay: number; failCount: number; lastSynchronizedAt: Date | null; queue: CrawlQueue };
export type CrawlProviderHead = CrawlBoard & {
  providerLastStartedAt: Date | null;
  readyBoards?: number;
  averageTurnMs?: number | null;
};
export const CRAWL_PROVIDER_MAX_WAIT_MS = 15 * 60_000;

/** A bounded preference for backlog that can be served cheaply; every provider retains a time floor. */
export function crawlProviderWeight(head: CrawlProviderHead, heads: readonly CrawlProviderHead[]): number {
  if (head.readyBoards === undefined) return 1;
  const maxBacklog = Math.max(1, ...heads.map(candidate => Math.max(1, candidate.readyBoards || 1)));
  const costs = heads.map(candidate => Math.min(60_000, Math.max(500, candidate.averageTurnMs || 5_000))).sort((a, b) => a - b);
  const referenceCost = costs[Math.floor((costs.length - 1) / 2)] || 5_000;
  const cost = Math.min(60_000, Math.max(500, head.averageTurnMs || 5_000));
  return Math.max(0.5, Math.min(4, (0.5 + 3.5 * Math.sqrt(Math.max(1, head.readyBoards) / maxBacklog)) * Math.sqrt(referenceCost / cost)));
}

/** Queue priority stays inside each provider. Durable task starts preserve fairness across restarts. */
export function selectFairCrawlBoard(heads: readonly CrawlProviderHead[], now = new Date()): CrawlProviderHead | null {
  return [...heads].sort((a, b) => {
    const aTime = a.providerLastStartedAt?.getTime() ?? -Infinity;
    const bTime = b.providerLastStartedAt?.getTime() ?? -Infinity;
    const aAge = Math.max(0, now.getTime() - aTime), bAge = Math.max(0, now.getTime() - bTime);
    // Unserved/long-waiting providers get the oldest turn before any weighted preference.
    if (aAge >= CRAWL_PROVIDER_MAX_WAIT_MS || bAge >= CRAWL_PROVIDER_MAX_WAIT_MS)
      return (aTime < bTime ? -1 : aTime > bTime ? 1 : 0) || a.platform.localeCompare(b.platform);
    return bAge * crawlProviderWeight(b, heads) - aAge * crawlProviderWeight(a, heads)
      || aTime - bTime || a.platform.localeCompare(b.platform);
  })[0] || null;
}
export async function nextCrawlBoard(platforms: readonly string[], turn: number, allowRetry: boolean, boards?: readonly string[], ownedTaskId?: string, client: Pick<PrismaClient, '$queryRaw'> = prisma, lane: PublicCrawlLane = 'all'): Promise<CrawlProviderHead | null> {
  if (!platforms.length || boards && !boards.length) return null;
  const order = crawlQueueOrder(turn, allowRetry);
  const rows = await client.$queryRaw<CrawlProviderHead[]>(Prisma.sql`
    -- Compute queue/ownership once. Inlining this CTE repeats the progress and
    -- open-work probes in each window sort/count across the entire due backlog.
    WITH candidates AS MATERIALIZED (
      SELECT board.slug,board.platform,board."checkDay",board."failCount",board."lastSynchronizedAt",board."nextCheckDate",board."lastAttemptedAt",t."lastStartedAt" AS "providerLastStartedAt",
        (ARRAY[${Prisma.join([...CRAWL_TURN_CYCLE])}]::text[])[mod(t.attempt+${ownedTaskId ? turn : 0},${CRAWL_TURN_CYCLE.length})+1] AS preferred_queue,
        CASE WHEN s.status IN ('partial','running') AND s."lastError" IS NULL
            AND (s.cursor->>'loaded'='true' OR CASE WHEN jsonb_typeof(s.cursor->'seen')='array' THEN jsonb_array_length(s.cursor->'seen') ELSE 0 END>0) THEN 'continuation'
          WHEN ${Prisma.raw(CRAWL_PENDING_DISCOVERY_SQL)} THEN 'first'
          WHEN board."failCount">0 OR s."lastError" IS NOT NULL THEN 'retry'
          WHEN board."lastSynchronizedAt" IS NULL THEN 'first' ELSE 'refresh' END AS queue
      FROM "AtsCompany" board LEFT JOIN "AtsBrowserSweep" s ON s.platform=board.platform AND s.slug=board.slug
      JOIN "IngestionTask" t ON t.source=CASE WHEN board.platform='gusto' THEN 'Gusto' ELSE 'ATS-'||board.platform END
        AND t."ingestionMode"='public-board' AND t."lifecycleStatus"='active'
      WHERE board.platform IN (${Prisma.join([...platforms])}) AND board.status IN ('active','parked')
        AND board."nextCheckDate"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND t."nextRunAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND (t."leaseToken" IS NULL OR t."leaseExpiresAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ${ownedTaskId ? Prisma.sql`OR t.id=${ownedTaskId}` : Prisma.empty})
        AND ${publicCrawlLaneSql(lane)}
        ${boards ? Prisma.sql`AND board.slug IN (${Prisma.join([...boards])})` : Prisma.empty}
    ), ranked AS (
      SELECT *,COUNT(*) OVER (PARTITION BY platform)::int AS "readyBoards",ROW_NUMBER() OVER (PARTITION BY platform ORDER BY
        CASE WHEN queue=preferred_queue THEN 0 ELSE array_position(ARRAY['continuation','refresh','first','retry']::text[],queue) END,
        "nextCheckDate","lastAttemptedAt" NULLS FIRST,slug) AS board_rank
      FROM candidates WHERE queue IN (${Prisma.join(order)})
    ) SELECT slug,platform,"checkDay","failCount","lastSynchronizedAt",queue,"providerLastStartedAt","readyBoards",
      ${platforms.length <= 1 ? Prisma.sql`NULL::double precision` : Prisma.sql`(
        SELECT AVG(LEAST(60000,GREATEST(500,recent."durationMs")))::double precision
        FROM (SELECT run."durationMs" FROM "IngestionSourceRun" run
          WHERE run.source=CASE WHEN ranked.platform='gusto' THEN 'Gusto' ELSE 'ATS-'||ranked.platform END
            AND run."ingestionMode"='public-board' AND run."finishedAt" IS NOT NULL
            AND (run.checkpoint->'crawl'->>'lane' IS NULL OR ${lane}='all' OR run.checkpoint->'crawl'->>'lane'=${lane})
            AND run."durationMs">0 AND run."createdAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '7 days'
          ORDER BY run."createdAt" DESC LIMIT 32) recent
      )`} AS "averageTurnMs"
    FROM ranked WHERE board_rank=1
  `);
  return selectFairCrawlBoard(rows);
}

/** Deterministic Chicago day/hour slots, evaluated as instants to handle DST. */
export function nextCrawlRefreshAt(identity: string, lastProductiveAt: string | undefined, now = new Date(), assignedDay?: number): { nextRunAt: Date; cadence: 'daily' | 'weekly' } {
  if (assignedDay !== undefined && (!Number.isInteger(assignedDay) || assignedDay < 0 || assignedDay > 6)) throw Error('Invalid assigned crawling weekday');
  const productive = lastProductiveAt ? Date.parse(lastProductiveAt) : NaN;
  const cadence = Number.isFinite(productive) && productive <= now.getTime() && productive >= now.getTime() - 14 * 86400000 ? 'daily' : 'weekly';
  const hash = createHash('sha256').update(identity).digest();
  const weekday = assignedDay ?? hash[0] % 7, hour = hash[1] % 24, minute = hash[2] % 60;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // At least 12 hours between productive refreshes and 24 hours for weekly boards.
  const floor = now.getTime() + (cadence === 'daily' ? 12 : 24) * 3600000;
  let slot = new Date(Math.ceil(floor / 3600000) * 3600000 + minute * 60000);
  for (let n = 0; n < 24 * 9; n++, slot = new Date(slot.getTime() + 3600000)) {
    const parts = format.formatToParts(slot), localHour = Number(parts.find(p => p.type === 'hour')?.value);
    const localDay = days.indexOf(parts.find(p => p.type === 'weekday')?.value || '');
    if (localHour === hour && (cadence === 'daily' || localDay === weekday)) return { cadence, nextRunAt: slot };
  }
  throw Error('No crawl refresh slot found');
}
