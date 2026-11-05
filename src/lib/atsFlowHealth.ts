import { Prisma } from './prismaClient';
import { atsEmployerVerificationHoldSql, ATS_EMPLOYER_RETRY_CODES } from './atsEmployerRetry';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';

export type AtsSourceFlow = {
  source: string;
  lane: 'public' | 'api';
  checkedLastHour: number;
  insertedLastHour: number;
  checkedLast30Minutes: number;
  capacityWaits: number;
  firstCapacityWaitAt: string | null;
  lastRunAt: string | null;
  lastProgressAt: string | null;
  stalled: boolean;
};
export type AtsFlowSnapshot = {
  observedAt: string;
  paused: boolean;
  readyToPublish: number;
  readyToProcess: number;
  employerHeld: number;
  unsealedEmployerHeld: number;
  scheduledRetries: number;
  oldestReadyAt: string | null;
  oldestEmployerHoldAt: string | null;
  checkedLastHour: number;
  insertedLastHour: number;
  sources: AtsSourceFlow[];
};

export function publicCapacityStalled(input: {
  paused: boolean; checkedLast30Minutes: number; capacityWaits: number;
  firstCapacityWaitAt: string | null; lastRunAt: string | null;
}, now: Date): boolean {
  const first = Date.parse(input.firstCapacityWaitAt || '');
  const last = Date.parse(input.lastRunAt || '');
  return !input.paused && input.checkedLast30Minutes === 0 && input.capacityWaits >= 3
    && Number.isFinite(first) && Number.isFinite(last)
    && now.getTime() - first >= 15 * 60_000
    && last <= now.getTime() && now.getTime() - last <= 5 * 60_000;
}

const iso = (value: unknown) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`).toISOString();
};
const count = (value: unknown) => Number(value || 0);

/** One shared outcome view for Stats and the watchdog. Attempts and clean
 * duplicate checks stay distinct; operator pauses are never starvation. */
export async function readAtsFlowSnapshot(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date(),
): Promise<AtsFlowSnapshot> {
  const utc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const hold = atsEmployerVerificationHoldSql();
  const rows = await client.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    WITH segments AS (
      SELECT
        COALESCE(SUM("itemCount") FILTER (WHERE status='sealed'),0)::bigint AS "readyToPublish",
        COALESCE(SUM(GREATEST("itemCount"-"processingOffset",0)) FILTER (
          WHERE status IN ('published','processing') AND NOT ${hold}
          AND (status='processing' OR "nextProcessAt" IS NULL OR "nextProcessAt"<=${utc})),0)::bigint AS "readyToProcess",
        COALESCE(SUM(GREATEST("itemCount"-"processingOffset",0)) FILTER (
          WHERE status IN ('published','processing') AND ${hold}),0)::bigint AS "employerHeld",
        COALESCE(SUM(GREATEST("itemCount"-"processingOffset",0)) FILTER (
          WHERE status='published' AND NOT ${hold} AND "nextProcessAt">${utc}),0)::bigint AS "scheduledRetries",
        MIN("sealedAt") FILTER (WHERE status='sealed') AS "oldestReadyAt",
        MIN("sealedAt") FILTER (WHERE status IN ('published','processing') AND ${hold}) AS "oldestEmployerHoldAt"
      FROM "AtsIngestionSegment" segment WHERE status IN ('sealed','published','processing')
    ), item_holds AS (
      SELECT COUNT(*)::bigint AS "unsealedEmployerHeld", MIN(item."createdAt") AS "oldestUnsealedHoldAt"
      FROM "AtsIngestionItem" item JOIN "AtsIngestionBatch" batch ON batch.id=item."batchId"
      WHERE item."enrichmentStatus"='pending' AND item."retryCode" IN (${Prisma.join(ATS_EMPLOYER_RETRY_CODES)})
        AND batch."activeLedgerGeneration"=item."ledgerGeneration" AND batch."writerMode"='v2'
    ), sources AS (
      SELECT source,
        SUM("seenCount")::bigint AS "checkedLastHour", SUM("insertedCount")::bigint AS "insertedLastHour",
        COALESCE(SUM("seenCount") FILTER (WHERE "createdAt">=${utc}-interval '30 minutes'),0)::bigint AS "checkedLast30Minutes",
        COUNT(*) FILTER (WHERE "createdAt">=${utc}-interval '30 minutes'
          AND error='Waiting for operator pause or ingestion capacity')::int AS "capacityWaits",
        MIN("createdAt") FILTER (WHERE "createdAt">=${utc}-interval '30 minutes'
          AND error='Waiting for operator pause or ingestion capacity') AS "firstCapacityWaitAt",
        MAX("createdAt") AS "lastRunAt", MAX("createdAt") FILTER (WHERE "seenCount">0) AS "lastProgressAt"
      FROM "IngestionSourceRun" WHERE "createdAt">=${utc}-interval '1 hour'
        AND "createdAt"<=${utc} AND source LIKE 'ATS-%' AND source NOT LIKE '% Details'
      GROUP BY source
    )
    SELECT segments.*, item_holds.*,
      (SELECT COALESCE(json_agg(sources ORDER BY source),'[]'::json) FROM sources) AS sources,
      COALESCE((SELECT "schedulePaused" AND ("pausedUntil" IS NULL OR "pausedUntil">${utc})
        FROM "PipelineState" WHERE id='global'),true) AS paused
    FROM segments CROSS JOIN item_holds
  `);
  const row = rows[0];
  if (!row) throw new Error('ATS flow telemetry is unavailable.');
  const paused = row.paused === true;
  const sources = (row.sources as Array<Record<string, unknown>>).map(value => {
    const source = String(value.source);
    const lane = NON_API_ATS_PLATFORMS.includes(source.replace(/^ATS-/, '')) ? 'public' as const : 'api' as const;
    const result = {
      source, lane, checkedLastHour: count(value.checkedLastHour), insertedLastHour: count(value.insertedLastHour),
      checkedLast30Minutes: count(value.checkedLast30Minutes), capacityWaits: count(value.capacityWaits),
      firstCapacityWaitAt: iso(value.firstCapacityWaitAt), lastRunAt: iso(value.lastRunAt), lastProgressAt: iso(value.lastProgressAt),
    };
    return { ...result, stalled: lane === 'public' && publicCapacityStalled({ ...result, paused }, now) };
  });
  return {
    observedAt: now.toISOString(), paused,
    readyToPublish: count(row.readyToPublish), readyToProcess: count(row.readyToProcess),
    employerHeld: count(row.employerHeld) + count(row.unsealedEmployerHeld),
    unsealedEmployerHeld: count(row.unsealedEmployerHeld), scheduledRetries: count(row.scheduledRetries),
    oldestReadyAt: row.oldestReadyAt instanceof Date ? row.oldestReadyAt.toISOString() : iso(row.oldestReadyAt),
    oldestEmployerHoldAt: [iso(row.oldestEmployerHoldAt), iso(row.oldestUnsealedHoldAt)]
      .filter((value): value is string => value !== null).sort()[0] || null,
    checkedLastHour: sources.reduce((n, source) => n + source.checkedLastHour, 0),
    insertedLastHour: sources.reduce((n, source) => n + source.insertedLastHour, 0), sources,
  };
}
