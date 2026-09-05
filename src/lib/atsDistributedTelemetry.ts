import { prisma } from './prisma';
import { ATS_ROTATION_DAY_NAMES } from './atsRotation';

/**
 * How long a held lane may report no completed board before the panel calls it
 * stuck rather than busy. Long enough that a slow paginated board does not trip
 * it, short enough that a hung worker is named within one coffee.
 */
export const ATS_ACQUISITION_STALL_MINUTES = 30;

/**
 * What the acquisition lane is actually doing, as one word.
 *
 * The counts alone cannot answer it: zero completions reads identically when
 * the rotation has finished, when every remaining board is held behind a
 * cooldown timer, and when eight lanes are wedged. The state is the reading
 * that separates them, and every other field on this record exists to justify
 * it.
 */
export type AtsAcquisitionState =
  | 'working'
  | 'waiting'
  | 'stuck'
  | 'done'
  | 'blocked'
  | 'stopped';

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
  boardsContactedLastHour: number;
  lastContactAt: Date | null;
  /** Today's rotation cohort, counted without regard to which tier claimed it. */
  rotationDay: number;
  cohortTotal: number;
  cohortSwept: number;
  /** Outstanding cohort boards that could be claimed this instant. */
  cohortReadyNow: number;
  /** When the next held board or batch becomes claimable. */
  nextUnlockAt: Date | null;
  unlockWithinHour: number;
  /** Open listing work whose hold has already lapsed. */
  dueBatches: number;
  weekActiveBoards: number;
  weekCoveredBoards: number;
  observedAt: Date;
};

type Row = Omit<AtsDistributedTelemetry, 'observedAt'>;

export async function readAtsDistributedTelemetry(): Promise<AtsDistributedTelemetry> {
  /**
   * Every comparison against a naive timestamp column is made against a naive
   * UTC value taken in the same statement. Comparing those columns to
   * CURRENT_TIMESTAMP instead would silently shift by the session's time zone,
   * which is how a Chicago session reads a five-hour-old row as due.
   */
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    WITH day AS (
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date AS local_day,
        EXTRACT(DOW FROM CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::int AS rotation_day,
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now_utc
    ),
    -- A board that was swept today is swept, whichever tier the dispatcher
    -- claimed it under. Classifying completions by selection tier subtracted
    -- recovered boards from the rotation they actually belong to.
    swept AS (
      SELECT DISTINCT sweep.slug, sweep.platform
      FROM "AtsEndpointSweepReceipt" sweep, day
      WHERE (sweep."processedAt" AT TIME ZONE 'America/Chicago')::date = day.local_day
    ),
    -- Today's weekday cohort: the boards the rotation owes a sweep, plus any
    -- board still in recovery that was nonetheless swept today. A failing board
    -- is not part of the rotation's promise, so it cannot sit in the
    -- denominator forever holding the bar short of complete -- but once it has
    -- actually been swept it counts, on both sides, exactly like any other.
    cohort AS (
      SELECT board.slug, board.platform, board."nextCheckDate"
      FROM "AtsCompany" board, day
      WHERE board."acquisitionEngine" = 'v2'
        AND board."checkDay" = day.rotation_day
        AND (
          board.status = 'active'
          OR EXISTS (
            SELECT 1 FROM swept s
            WHERE s.slug = board.slug AND s.platform = board.platform
          )
        )
    ),
    outstanding AS (
      SELECT c.slug, c.platform, c."nextCheckDate"
      FROM cohort c
      WHERE NOT EXISTS (
        SELECT 1 FROM swept s WHERE s.slug = c.slug AND s.platform = c.platform
      )
    )
    SELECT
      (SELECT rotation_day FROM day) AS "rotationDay",
      (SELECT COUNT(*)::int FROM cohort) AS "cohortTotal",
      (SELECT COUNT(*)::int FROM cohort c
        JOIN swept s ON s.slug = c.slug AND s.platform = c.platform) AS "cohortSwept",
      (SELECT COUNT(*)::int FROM outstanding o, day
        WHERE o."nextCheckDate" <= day.now_utc
          AND NOT EXISTS (
            SELECT 1 FROM "AtsIngestionBatch" b
            WHERE b.slug = o.slug AND b.platform = o.platform
              AND b.status IN ('fetching', 'partial', 'synchronized')
          )) AS "cohortReadyNow",
      (SELECT MIN(t) FROM (
        SELECT MIN(o."nextCheckDate") AS t FROM outstanding o, day
          WHERE o."nextCheckDate" > day.now_utc
        UNION ALL
        SELECT MIN(b."nextAcquireAt") FROM "AtsIngestionBatch" b, day
          WHERE b.status = 'fetching' AND b."nextAcquireAt" > day.now_utc
      ) u) AS "nextUnlockAt",
      (SELECT COUNT(*)::int FROM "AtsIngestionBatch" b, day
        WHERE b.status = 'fetching'
          AND b."nextAcquireAt" > day.now_utc
          AND b."nextAcquireAt" <= day.now_utc + INTERVAL '1 hour') AS "unlockWithinHour",
      -- Listing work whose hold has already expired. A lane wedged on an open
      -- batch drives the claimable-board count to zero, so without this the
      -- worst hang there is would report as patience.
      (SELECT COUNT(*)::int FROM "AtsIngestionBatch" b, day
        WHERE b.status = 'fetching'
          AND (b."nextAcquireAt" IS NULL OR b."nextAcquireAt" <= day.now_utc)) AS "dueBatches",
      (SELECT COUNT(*)::int FROM "AtsCompany" b WHERE b.status = 'active') AS "weekActiveBoards",
      (SELECT COUNT(*)::int FROM "AtsCompany" b, day
        WHERE b.status = 'active'
          AND b."lastCheckedAt" > day.now_utc - INTERVAL '7 days') AS "weekCoveredBoards",
      (SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" s, day
        WHERE s."workerKind" = 'mac-continuation'
          AND s."leaseExpiresAt" > day.now_utc) AS "remoteSlots",
      (SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" s, day
        WHERE s."workerKind" = 'pi-acquisition'
          AND s."leaseExpiresAt" > day.now_utc) AS "piSlots",
      (SELECT g."globalSlotLimit" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "globalSlotLimit",
      (SELECT g."localSlotReserve" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "localSlotReserve",
      (SELECT g."admissionState" FROM "AtsAcquisitionRuntimeGate" g WHERE g.id = 'global')
        AS "admissionState",
      (SELECT COUNT(*)::int FROM "AtsEndpointDailyContactReceipt" c, day
        WHERE c."contactConfirmedAt" > day.now_utc - INTERVAL '1 hour'
          AND c."contactKind" = 'new_cycle_listing') AS "boardsContactedLastHour",
      (SELECT MAX(c."contactConfirmedAt") FROM "AtsEndpointDailyContactReceipt" c
        WHERE c."contactKind" = 'new_cycle_listing') AS "lastContactAt"
  `);
  const row = rows[0];
  const date = (value: unknown): Date | null => (value ? new Date(value as string) : null);
  return {
    remoteSlots: Number(row?.remoteSlots || 0),
    piSlots: Number(row?.piSlots || 0),
    globalSlotLimit: Number(row?.globalSlotLimit || 0),
    localSlotReserve: Number(row?.localSlotReserve || 0),
    admissionState: String(row?.admissionState || 'unknown'),
    boardsContactedLastHour: Number(row?.boardsContactedLastHour || 0),
    lastContactAt: date(row?.lastContactAt),
    rotationDay: Number(row?.rotationDay || 0),
    cohortTotal: Number(row?.cohortTotal || 0),
    cohortSwept: Number(row?.cohortSwept || 0),
    cohortReadyNow: Number(row?.cohortReadyNow || 0),
    nextUnlockAt: date(row?.nextUnlockAt),
    unlockWithinHour: Number(row?.unlockWithinHour || 0),
    dueBatches: Number(row?.dueBatches || 0),
    weekActiveBoards: Number(row?.weekActiveBoards || 0),
    weekCoveredBoards: Number(row?.weekCoveredBoards || 0),
    observedAt: new Date(),
  };
}

/**
 * The one word, and the evidence that picked it.
 *
 * Ordered so that a cause outranks its symptom: a paused gate and a dead worker
 * both stop completions, and neither should be reported as a stall in the
 * boards themselves.
 */
export function deriveAtsAcquisitionState(
  telemetry: AtsDistributedTelemetry,
  now: Date = new Date(),
): AtsAcquisitionState {
  const outstanding = Math.max(0, telemetry.cohortTotal - telemetry.cohortSwept);
  const lanesHeld = telemetry.remoteSlots + telemetry.piSlots;
  const staleMinutes = telemetry.lastContactAt
    ? (now.valueOf() - telemetry.lastContactAt.valueOf()) / 60_000
    : Number.POSITIVE_INFINITY;

  if (lanesHeld === 0 && telemetry.localSlotReserve === 0) return 'stopped';
  if (telemetry.admissionState !== 'open') return 'blocked';
  if (outstanding === 0) return 'done';
  // Work is there to be done -- either a claimable board, or an open batch
  // whose hold has lapsed -- lanes are held, and nothing has landed in half an
  // hour. That is the only reading that should send anyone looking.
  const workAvailable = telemetry.cohortReadyNow > 0 || telemetry.dueBatches > 0;
  if (lanesHeld > 0 && staleMinutes >= ATS_ACQUISITION_STALL_MINUTES && workAvailable) {
    return 'stuck';
  }
  if (telemetry.cohortReadyNow === 0) return 'waiting';
  return 'working';
}

/**
 * A labelled transport, not a sentence.
 *
 * The panel builds its own prose from these fields, so the wording can change
 * without touching the producer, and a segment that goes missing costs one
 * reading rather than the whole line.
 */
export function formatAtsDistributedTelemetry(
  telemetry: AtsDistributedTelemetry,
  now: Date = new Date(),
): string {
  const dayName = ATS_ROTATION_DAY_NAMES[telemetry.rotationDay] || 'Rotation';
  return [
    `State ${deriveAtsAcquisitionState(telemetry, now)}`,
    `Rotation ${dayName}`,
    `Boards ${telemetry.cohortSwept}/${telemetry.cohortTotal}`,
    `Ready ${telemetry.cohortReadyNow}`,
    `Unlock ${telemetry.nextUnlockAt ? telemetry.nextUnlockAt.toISOString() : 'none'}`,
    `Unlocking ${telemetry.unlockWithinHour}`,
    `Lanes ${telemetry.remoteSlots + telemetry.piSlots}/${telemetry.globalSlotLimit}`,
    `Rate ${telemetry.boardsContactedLastHour}`,
    `Week ${telemetry.weekCoveredBoards}/${telemetry.weekActiveBoards}`,
  ].join(' · ');
}
