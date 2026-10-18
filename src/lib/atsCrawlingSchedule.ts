import { createHash } from 'node:crypto';
import { Prisma } from './prismaClient';
import { prisma } from './prisma';

export type CrawlQueue = 'continuation' | 'refresh' | 'first' | 'retry';
export const CRAWL_TURN_CYCLE: readonly CrawlQueue[] = ['continuation', 'refresh', 'first', 'continuation', 'refresh', 'first', 'continuation', 'refresh', 'continuation', 'retry'];
export function crawlQueueOrder(turn: number, allowRetry: boolean): CrawlQueue[] {
  const preferred = CRAWL_TURN_CYCLE[turn % CRAWL_TURN_CYCLE.length];
  return [...new Set([preferred, 'continuation', 'refresh', 'first', 'retry'] as CrawlQueue[])].filter(q => q !== 'retry' || allowRetry);
}
export type CrawlBoard = { slug: string; platform: string; failCount: number; lastSynchronizedAt: Date | null; queue: CrawlQueue };
export async function nextCrawlBoard(platforms: readonly string[], turn: number, allowRetry: boolean, boards?: readonly string[], ownedTaskId?: string): Promise<CrawlBoard | null> {
  if (!platforms.length || boards && !boards.length) return null;
  const order = crawlQueueOrder(turn, allowRetry);
  const rows = await prisma.$queryRaw<CrawlBoard[]>(Prisma.sql`
    WITH candidates AS (
      SELECT b.slug,b.platform,b."failCount",b."lastSynchronizedAt",b."nextCheckDate",b."lastAttemptedAt",
        CASE WHEN s.status IN ('partial','running') AND s."lastError" IS NULL
            AND (s.cursor->>'loaded'='true' OR CASE WHEN jsonb_typeof(s.cursor->'seen')='array' THEN jsonb_array_length(s.cursor->'seen') ELSE 0 END>0) THEN 'continuation'
          WHEN b."failCount">0 OR s."lastError" IS NOT NULL THEN 'retry'
          WHEN b."lastSynchronizedAt" IS NULL THEN 'first' ELSE 'refresh' END AS queue
      FROM "AtsCompany" b LEFT JOIN "AtsBrowserSweep" s ON s.platform=b.platform AND s.slug=b.slug
      JOIN "IngestionTask" t ON t.source=CASE WHEN b.platform='gusto' THEN 'Gusto' ELSE 'ATS-'||b.platform END
        AND t."ingestionMode"='public-board' AND t."lifecycleStatus"='active'
      WHERE b.platform IN (${Prisma.join([...platforms])}) AND b.status IN ('active','parked')
        AND b."nextCheckDate"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND t."nextRunAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND (t."leaseToken" IS NULL OR t."leaseExpiresAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ${ownedTaskId ? Prisma.sql`OR t.id=${ownedTaskId}` : Prisma.empty})
        ${boards ? Prisma.sql`AND b.slug IN (${Prisma.join([...boards])})` : Prisma.empty}
    ) SELECT slug,platform,"failCount","lastSynchronizedAt",queue FROM candidates
      WHERE queue IN (${Prisma.join(order)})
      ORDER BY array_position(ARRAY[${Prisma.join(order)}]::text[],queue),"nextCheckDate","lastAttemptedAt" NULLS FIRST,platform,slug LIMIT 1
  `);
  return rows[0] || null;
}

/** Deterministic Chicago day/hour slots, evaluated as instants to handle DST. */
export function nextCrawlRefreshAt(identity: string, lastProductiveAt: string | undefined, now = new Date()): { nextRunAt: Date; cadence: 'daily' | 'weekly' } {
  const productive = lastProductiveAt ? Date.parse(lastProductiveAt) : NaN;
  const cadence = Number.isFinite(productive) && productive <= now.getTime() && productive >= now.getTime() - 14 * 86400000 ? 'daily' : 'weekly';
  const hash = createHash('sha256').update(identity).digest();
  const weekday = hash[0] % 7, hour = hash[1] % 24, minute = hash[2] % 60;
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
