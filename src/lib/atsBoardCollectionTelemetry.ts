import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';
import { prisma } from './prisma';
import { Prisma } from './prismaClient';

export type AtsBoardCollectionTelemetry = {
  dueBoards: number;
  sweptToday: number;
  runningSources: string[];
  awaitingRetry: boolean;
};

export async function readAtsBoardCollectionTelemetry(now = new Date(), client: Pick<Prisma.TransactionClient, '$queryRaw' | 'ingestionTask'> = prisma): Promise<AtsBoardCollectionTelemetry> {
  const sources = NON_API_ATS_PLATFORMS.map((platform) => platform === 'gusto' ? 'Gusto' : `ATS-${platform}`);
  const [rows, tasks] = await Promise.all([
    client.$queryRaw<Array<{ dueBoards: number; sweptToday: number }>>`
      WITH clock AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now_utc,
          (((CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date::timestamp
            AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC') AS day_start_utc
      )
      SELECT COUNT(*) FILTER (WHERE board.status IN ('active', 'parked')
          AND board."nextCheckDate" <= clock.now_utc)::int AS "dueBoards",
        COUNT(*) FILTER (WHERE board."lastSynchronizedAt" >= clock.day_start_utc)::int AS "sweptToday"
      FROM "AtsCompany" board CROSS JOIN clock
      WHERE board.platform IN (${Prisma.join([...NON_API_ATS_PLATFORMS])})
    `,
    client.ingestionTask.findMany({
      where: { source: { in: sources }, ingestionMode: 'public-board', lifecycleStatus: 'active' },
      select: { source: true, status: true, leaseToken: true, leaseExpiresAt: true },
    }),
  ]);
  return {
    dueBoards: rows[0]?.dueBoards ?? 0,
    sweptToday: rows[0]?.sweptToday ?? 0,
    runningSources: tasks.filter((task) => task.status === 'running' && task.leaseToken !== null
      && task.leaseExpiresAt !== null && task.leaseExpiresAt > now)
      .map((task) => task.source.replace(/^ATS-/, '')).sort(),
    awaitingRetry: tasks.some((task) => task.status === 'failed' || task.status === 'partial'),
  };
}

export function formatAtsBoardCollectionTelemetry(telemetry: AtsBoardCollectionTelemetry): string {
  const state = telemetry.runningSources.length ? `working (${telemetry.runningSources.join(', ')})`
    : telemetry.awaitingRetry ? 'awaiting retry' : 'waiting';
  return `ATS Board Collection: ${state} · ${telemetry.dueBoards.toLocaleString('en-US')} boards due · ${telemetry.sweptToday.toLocaleString('en-US')} swept today`;
}
