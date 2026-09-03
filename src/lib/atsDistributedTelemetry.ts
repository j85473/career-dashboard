import { prisma } from './prisma';
import { ATS_DAILY_BOARD_TARGET } from './atsRotation';

/**
 * Live acquisition state for the operator ticker, read entirely from durable
 * rows. The Pi used to report this from its in-process acquisition child; once
 * every lane moved to the Mac that child no longer exists, so the lane would
 * otherwise sit on a stale string forever. Every number here is written by
 * whichever host is actually acquiring, so the ticker stays truthful no matter
 * where the lanes run.
 */
export type AtsDistributedTelemetry = {
  remoteSlots: number;
  piSlots: number;
  globalSlotLimit: number;
  localSlotReserve: number;
  admissionState: string;
  contactsToday: number;
  dailyTarget: number;
  activeBatches: number;
  boardsContactedLastHour: number;
  itemsEnrichedLastHour: number;
  lastContactAt: Date | null;
  todayBoardsCompleted: number;
  todayBoardsTotal: number;
  backlogBoardsCompleted: number;
  backlogBoardsTotal: number;
  cooldownBoardsCompleted: number;
  cooldownBoardsTotal: number;
  observedAt: Date;
};

type Row = {
  remoteSlots: number;
  piSlots: number;
  globalSlotLimit: number;
  localSlotReserve: number;
  admissionState: string;
  contactsToday: number;
  activeBatches: number;
  boardsContactedLastHour: number;
  itemsEnrichedLastHour: number;
  lastContactAt: Date | null;
  todayBoardsCompleted: number;
  todayBoardsTotal: number;
  backlogBoardsCompleted: number;
  backlogBoardsTotal: number;
  cooldownBoardsCompleted: number;
  cooldownBoardsTotal: number;
};

export async function readAtsDistributedTelemetry(): Promise<AtsDistributedTelemetry> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    WITH chicago_day AS (
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date AS local_day,
        EXTRACT(DOW FROM CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::int AS rotation_day
    ),
    eligible_work AS (
      SELECT
        board.slug,
        board.platform,
        CASE
          WHEN board.status IN ('parked', 'blacklisted') THEN 'cooldown'
          WHEN board."checkDay" = day.rotation_day THEN 'today'
          ELSE 'backlog'
        END AS cohort,
        FALSE AS completed
      FROM "AtsCompany" board, chicago_day day
      WHERE board."acquisitionEngine" = 'v2'
        AND (
          (board.status = 'active' AND (
            board."checkDay" = day.rotation_day
            OR board."nextCheckDate" <= CURRENT_TIMESTAMP
          ))
          OR (board.status IN ('parked', 'blacklisted')
            AND board."nextCheckDate" <= CURRENT_TIMESTAMP)
        )
    ),
    sweep_work AS (
      SELECT
        sweep.slug,
        sweep.platform,
        CASE
          WHEN sweep."selectionTier" = 'cooldown'
            OR (sweep."selectionTier" = 'unclassified'
              AND board.status IN ('parked', 'blacklisted')) THEN 'cooldown'
          WHEN board."checkDay" = day.rotation_day THEN 'today'
          ELSE 'backlog'
        END AS cohort,
        COALESCE(
          (sweep."processedAt" AT TIME ZONE 'America/Chicago')::date = day.local_day,
          FALSE
        ) AS completed
      FROM "AtsEndpointSweepReceipt" sweep
      INNER JOIN "AtsCompany" board
        ON board.slug = sweep.slug AND board.platform = sweep.platform
      CROSS JOIN chicago_day day
      WHERE sweep."processedAt" IS NULL
        OR (sweep."processedAt" AT TIME ZONE 'America/Chicago')::date = day.local_day
    ),
    cohort_work AS (
      SELECT
        work.slug,
        work.platform,
        work.cohort,
        BOOL_OR(work.completed) AS completed
      FROM (
        SELECT * FROM eligible_work
        UNION ALL
        SELECT * FROM sweep_work
      ) work
      GROUP BY work.slug, work.platform, work.cohort
    ),
    progress AS (
      SELECT
        COUNT(*) FILTER (WHERE cohort = 'today' AND completed)::int AS "todayBoardsCompleted",
        COUNT(*) FILTER (WHERE cohort = 'today')::int AS "todayBoardsTotal",
        COUNT(*) FILTER (WHERE cohort = 'backlog' AND completed)::int AS "backlogBoardsCompleted",
        COUNT(*) FILTER (WHERE cohort = 'backlog')::int AS "backlogBoardsTotal",
        COUNT(*) FILTER (WHERE cohort = 'cooldown' AND completed)::int AS "cooldownBoardsCompleted",
        COUNT(*) FILTER (WHERE cohort = 'cooldown')::int AS "cooldownBoardsTotal"
      FROM cohort_work
    )
    SELECT
      (SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" s
        WHERE s."workerKind" = 'mac-continuation'
          AND s."leaseExpiresAt" > CURRENT_TIMESTAMP) AS "remoteSlots",
      (SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" s
        WHERE s."workerKind" = 'pi-acquisition'
          AND s."leaseExpiresAt" > CURRENT_TIMESTAMP) AS "piSlots",
      (SELECT g."globalSlotLimit" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "globalSlotLimit",
      (SELECT g."localSlotReserve" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "localSlotReserve",
      (SELECT g."admissionState" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "admissionState",
      (SELECT COUNT(*)::int FROM "AtsEndpointDailyContactReceipt" c
        WHERE c."localDay" = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date
          AND c."contactKind" = 'new_cycle_listing') AS "contactsToday",
      (SELECT COUNT(*)::int FROM "AtsIngestionBatch" b
        WHERE b."writerMode" = 'v2'
          AND b.status IN ('fetching', 'partial', 'synchronized')) AS "activeBatches",
      (SELECT COUNT(*)::int FROM "AtsEndpointDailyContactReceipt" c
        WHERE c."contactConfirmedAt" > CURRENT_TIMESTAMP - INTERVAL '1 hour'
          AND c."contactKind" = 'new_cycle_listing') AS "boardsContactedLastHour",
      (SELECT COUNT(*)::int FROM "AtsIngestionItem" i
        WHERE i."terminalAt" > CURRENT_TIMESTAMP - INTERVAL '1 hour') AS "itemsEnrichedLastHour",
      (SELECT MAX(c."contactConfirmedAt") FROM "AtsEndpointDailyContactReceipt" c
        WHERE c."contactKind" = 'new_cycle_listing') AS "lastContactAt",
      progress."todayBoardsCompleted",
      progress."todayBoardsTotal",
      progress."backlogBoardsCompleted",
      progress."backlogBoardsTotal",
      progress."cooldownBoardsCompleted",
      progress."cooldownBoardsTotal"
    FROM progress
  `);
  const row = rows[0];
  return {
    remoteSlots: Number(row?.remoteSlots || 0),
    piSlots: Number(row?.piSlots || 0),
    globalSlotLimit: Number(row?.globalSlotLimit || 0),
    localSlotReserve: Number(row?.localSlotReserve || 0),
    admissionState: String(row?.admissionState || 'unknown'),
    contactsToday: Number(row?.contactsToday || 0),
    dailyTarget: ATS_DAILY_BOARD_TARGET,
    activeBatches: Number(row?.activeBatches || 0),
    boardsContactedLastHour: Number(row?.boardsContactedLastHour || 0),
    itemsEnrichedLastHour: Number(row?.itemsEnrichedLastHour || 0),
    lastContactAt: row?.lastContactAt ? new Date(row.lastContactAt) : null,
    todayBoardsCompleted: Number(row?.todayBoardsCompleted || 0),
    todayBoardsTotal: Number(row?.todayBoardsTotal || 0),
    backlogBoardsCompleted: Number(row?.backlogBoardsCompleted || 0),
    backlogBoardsTotal: Number(row?.backlogBoardsTotal || 0),
    cooldownBoardsCompleted: Number(row?.cooldownBoardsCompleted || 0),
    cooldownBoardsTotal: Number(row?.cooldownBoardsTotal || 0),
    observedAt: new Date(),
  };
}

/**
 * A worker is only "live" if it holds a lease. Leases expire in minutes, so an
 * agent that died shows as no slots rather than as its last cheerful message.
 */
export function formatAtsDistributedTelemetry(
  telemetry: AtsDistributedTelemetry,
  now: Date = new Date(),
): string {
  const number = (value: number) => value.toLocaleString('en-US');
  const staleMs = telemetry.lastContactAt
    ? now.valueOf() - telemetry.lastContactAt.valueOf()
    : null;
  const state = telemetry.remoteSlots === 0 && telemetry.localSlotReserve === 0
    ? 'Worker stopped'
    : telemetry.admissionState === 'draining'
      ? 'Admissions paused'
      : staleMs !== null && staleMs > 10 * 60_000
        ? `Last board ${Math.round(staleMs / 60_000)}m ago`
        : 'Running';
  return [
    // Names the lanes, not the machine: this counter is leased remote worker
    // slots, and it read 'Mac' for a day after acquisition moved to the M70.
    `Workers ${telemetry.remoteSlots}/${telemetry.globalSlotLimit} lanes`,
    `Today complete ${number(telemetry.todayBoardsCompleted)}/${number(telemetry.todayBoardsTotal)}`,
    `Backlog complete ${number(telemetry.backlogBoardsCompleted)}/${number(telemetry.backlogBoardsTotal)}`,
    `Cooldown complete ${number(telemetry.cooldownBoardsCompleted)}/${number(telemetry.cooldownBoardsTotal)}`,
    state,
  ].join(' · ');
}
