import { Prisma } from '@prisma/client';
import { buildIngestionTaskKey } from './ingestionControl';
import { GUSTO_PAID_SEARCH_TASK_DEFINITION } from './ingestionTaskCatalog';
import { prisma } from './prisma';

export const GUSTO_API_HANDOFF_REASON = 'Moved to paid-search browser collection; Gusto has no supported ATS listing API.';

/** Only unused API envelopes can be closed. Acquired data and live work stay intact. */
export function emptyGustoApiBatchWhere(): Prisma.AtsIngestionBatchWhereInput {
  return {
    platform: 'gusto',
    writerMode: 'v2',
    status: { in: ['fetching', 'partial', 'synchronized'] },
    acquisitionPhase: 'listing',
    jobCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    processingErrorCount: 0,
    processingOffset: 0,
    listingOffset: 0,
    pageCount: 0,
    rawObservationCount: 0,
    canonicalOccurrenceCount: 0,
    compactedOccurrenceCount: 0,
    terminalItemCount: 0,
    sealedItemCount: 0,
    publishedItemCount: 0,
    processedAt: null,
    leaseToken: null,
    acquisitionClaimToken: null,
    OR: [{ payload: { equals: Prisma.DbNull } }, { payload: { equals: Prisma.JsonNull } }, { payload: { equals: [] } }],
    pages: { none: {} },
    observations: { none: {} },
    observationResolutions: { none: {} },
    items: { none: {} },
    segments: { none: {} },
    workReceipts: { none: { finishedAt: null } },
    attempts: { none: { outcome: 'running' } },
  };
}

/** Retain the old envelope and receipts as routed history, never as a successful API sweep. */
export async function reconcileGustoApiBatches(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
    const candidates = await tx.atsIngestionBatch.findMany({
      where: emptyGustoApiBatchWhere(),
      select: { id: true },
      take: 25,
      orderBy: { id: 'asc' },
    });
    if (!candidates.length) return 0;
    // Serialize this handoff with any older acquisition worker.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "AtsIngestionBatch"
      WHERE id IN (${Prisma.join(candidates.map((batch) => batch.id))})
      FOR UPDATE SKIP LOCKED
    `;
    const ids = locked.map((batch) => batch.id);
    if (!ids.length) return 0;
    const routed = await tx.atsIngestionBatch.updateMany({
      where: { ...emptyGustoApiBatchWhere(), id: { in: ids } },
      data: { status: 'routed', lastError: GUSTO_API_HANDOFF_REASON, nextAcquireAt: null },
    });
    const routedRows = await tx.atsIngestionBatch.findMany({
      where: { id: { in: ids }, status: 'routed' },
      select: { id: true },
    });
    await tx.atsEndpointSweepReceipt.updateMany({
      where: { batchId: { in: routedRows.map((batch) => batch.id) }, processedAt: null, state: { not: 'succeeded' } },
      data: { state: 'failed', outcome: 'routed_to_paid_search', safetyBlockReason: GUSTO_API_HANDOFF_REASON },
    });
    return routed.count;
  }, { maxWait: 5_000, timeout: 30_000 });
}

export type GustoPaidSearchTelemetry = {
  dueBoards: number;
  sweptToday: number;
  running: boolean;
  lastFailed: boolean;
};

export async function readGustoPaidSearchTelemetry(now = new Date()): Promise<GustoPaidSearchTelemetry> {
  const [rows, task] = await Promise.all([
    prisma.$queryRaw<Array<{ dueBoards: number; sweptToday: number }>>`
      WITH clock AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now_utc,
          (((CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date::timestamp
            AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC') AS day_start_utc
      )
      SELECT COUNT(*) FILTER (WHERE board.status IN ('active', 'parked')
          AND board."nextCheckDate" <= clock.now_utc)::int AS "dueBoards",
        COUNT(*) FILTER (WHERE board."lastSynchronizedAt" >= clock.day_start_utc)::int AS "sweptToday"
      FROM "AtsCompany" board CROSS JOIN clock WHERE board.platform = 'gusto'
    `,
    prisma.ingestionTask.findUnique({
      where: { taskKey: buildIngestionTaskKey(GUSTO_PAID_SEARCH_TASK_DEFINITION.spec) },
      select: { status: true, leaseToken: true, leaseExpiresAt: true },
    }),
  ]);
  return {
    dueBoards: rows[0]?.dueBoards ?? 0,
    sweptToday: rows[0]?.sweptToday ?? 0,
    running: task?.status === 'running' && task.leaseToken !== null
      && task.leaseExpiresAt !== null && task.leaseExpiresAt > now,
    lastFailed: task?.status === 'failed' || task?.status === 'partial',
  };
}

export function formatGustoPaidSearchTelemetry(telemetry: GustoPaidSearchTelemetry): string {
  const state = telemetry.running ? 'working' : telemetry.lastFailed ? 'awaiting retry' : 'waiting';
  return `Gusto paid search (browser): ${state} · ${telemetry.dueBoards.toLocaleString('en-US')} boards due · ${telemetry.sweptToday.toLocaleString('en-US')} swept today`;
}
