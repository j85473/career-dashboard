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
  macSlots: number;
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
  observedAt: Date;
};

type Row = {
  macSlots: number;
  piSlots: number;
  globalSlotLimit: number;
  localSlotReserve: number;
  admissionState: string;
  contactsToday: number;
  activeBatches: number;
  boardsContactedLastHour: number;
  itemsEnrichedLastHour: number;
  lastContactAt: Date | null;
};

export async function readAtsDistributedTelemetry(): Promise<AtsDistributedTelemetry> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      (SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" s
        WHERE s."workerKind" = 'mac-continuation'
          AND s."leaseExpiresAt" > CURRENT_TIMESTAMP) AS "macSlots",
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
        WHERE c."contactKind" = 'new_cycle_listing') AS "lastContactAt"
  `);
  const row = rows[0];
  return {
    macSlots: Number(row?.macSlots || 0),
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
  const hosts: string[] = [];
  if (telemetry.macSlots > 0) hosts.push(`Mac ${telemetry.macSlots}/${telemetry.globalSlotLimit} lanes`);
  if (telemetry.piSlots > 0) hosts.push(`Pi ${telemetry.piSlots} lanes`);
  if (hosts.length === 0) {
    return telemetry.localSlotReserve === 0
      ? 'No acquisition worker holds a lane · the Mac worker is not running'
      : 'Idle · no worker holds a lane';
  }
  const staleMs = telemetry.lastContactAt
    ? now.valueOf() - telemetry.lastContactAt.valueOf()
    : null;
  const staleness = staleMs !== null && staleMs > 10 * 60_000
    ? ` · last board ${Math.round(staleMs / 60_000)}m ago`
    : '';
  const admissions = telemetry.admissionState === 'draining' ? ' · admissions paused' : '';
  return [
    hosts.join(' + '),
    `${number(telemetry.contactsToday)}/${number(telemetry.dailyTarget)} boards today`,
    `${number(telemetry.boardsContactedLastHour)} boards/h`,
    `${number(telemetry.itemsEnrichedLastHour)} enriched/h`,
    `${number(telemetry.activeBatches)} active`,
  ].join(' · ') + admissions + staleness;
}
