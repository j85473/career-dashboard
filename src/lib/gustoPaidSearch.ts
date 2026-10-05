import { Prisma } from '@prisma/client';
import { buildIngestionTaskKey } from './ingestionControl';
import { GUSTO_PAID_SEARCH_TASK_DEFINITION } from './ingestionTaskCatalog';
import { prisma } from './prisma';

export const GUSTO_API_HANDOFF_REASON = 'Moved to paid-search browser collection; Gusto has no supported ATS listing API.';

/** Cheap first pass: inspect only batch columns before checking related data. */
function emptyGustoApiBatchScalarWhere(): Prisma.AtsIngestionBatchWhereInput {
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
  };
}

/** Only unused API envelopes can be closed. Acquired data and live work stay intact. */
export function emptyGustoApiBatchWhere(): Prisma.AtsIngestionBatchWhereInput {
  return {
    ...emptyGustoApiBatchScalarWhere(),
    pages: { none: {} },
    observations: { none: {} },
    observationResolutions: { none: {} },
    items: { none: {} },
    segments: { none: {} },
    workReceipts: { none: { finishedAt: null } },
    attempts: { none: { outcome: 'running' } },
  };
}

/** Correlated probes use each batch's indexes instead of global NOT IN scans. */
export function gustoApiHandoffGuardSql(): Prisma.Sql {
  return Prisma.sql`
    batch.platform = 'gusto' AND batch."writerMode" = 'v2'
    AND batch.status IN ('fetching', 'partial', 'synchronized')
    AND batch."acquisitionPhase" = 'listing'
    AND batch."jobCount" = 0 AND batch."insertedCount" = 0
    AND batch."duplicateCount" = 0 AND batch."filteredCount" = 0
    AND batch."processingErrorCount" = 0 AND batch."processingOffset" = 0
    AND batch."listingOffset" = 0 AND batch."pageCount" = 0
    AND batch."rawObservationCount" = 0 AND batch."canonicalOccurrenceCount" = 0
    AND batch."compactedOccurrenceCount" = 0 AND batch."terminalItemCount" = 0
    AND batch."sealedItemCount" = 0 AND batch."publishedItemCount" = 0
    AND batch."processedAt" IS NULL AND batch."leaseToken" IS NULL
    AND batch."acquisitionClaimToken" IS NULL
    AND (batch.payload IS NULL OR batch.payload = 'null'::jsonb OR batch.payload = '[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM "AtsIngestionPage" child WHERE child."batchId" = batch.id)
    AND NOT EXISTS (SELECT 1 FROM "AtsListingObservation" child WHERE child."batchId" = batch.id)
    AND NOT EXISTS (SELECT 1 FROM "AtsListingObservationResolution" child WHERE child."batchId" = batch.id)
    AND NOT EXISTS (SELECT 1 FROM "AtsIngestionItem" child WHERE child."batchId" = batch.id)
    AND NOT EXISTS (SELECT 1 FROM "AtsIngestionSegment" child WHERE child."batchId" = batch.id)
    AND NOT EXISTS (SELECT 1 FROM "AtsAcquisitionWorkReceipt" child WHERE child."batchId" = batch.id AND child."finishedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "AtsBoardCheckAttempt" child WHERE child."batchId" = batch.id AND child.outcome = 'running')
  `;
}

export function gustoApiHandoffCandidatesSql(ids: string[], lock = true): Prisma.Sql {
  if (!ids.length) throw new Error('Gusto handoff requires a bounded candidate window');
  if (ids.length > 100) throw new Error('Gusto handoff window exceeds 100 batches');
  return Prisma.sql`
    WITH candidate_window AS MATERIALIZED (
      SELECT batch.id FROM "AtsIngestionBatch" batch WHERE batch.id IN (${Prisma.join(ids)})
    )
    SELECT batch.id FROM candidate_window candidate
    JOIN "AtsIngestionBatch" batch ON batch.id = candidate.id
    WHERE ${gustoApiHandoffGuardSql()}
    ORDER BY batch.id LIMIT 25 ${lock ? Prisma.sql`FOR UPDATE OF batch SKIP LOCKED` : Prisma.empty}
  `;
}

/** Retain the old envelope and receipts as routed history, never as a successful API sweep. */
export async function reconcileGustoApiBatches(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Prisma's transaction timeout does not interrupt a query already running
    // on PostgreSQL. Bound every query so browser collection cannot wait for
    // minutes if a future planner choice regresses this handoff.
    await tx.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true), set_config('statement_timeout', '10000', true)`;
    let afterId: string | null = null;
    while (true) {
      // The full relation guard across thousands of historical envelopes took
      // over ten minutes on M70. Bound it to one small, indexed ID window.
      const candidateWindow: Array<{ id: string }> = await tx.atsIngestionBatch.findMany({
        where: { ...emptyGustoApiBatchScalarWhere(), ...(afterId ? { id: { gt: afterId } } : {}) },
        select: { id: true },
        take: 100,
        orderBy: { id: 'asc' },
      });
      if (!candidateWindow.length) return 0;
      afterId = candidateWindow[candidateWindow.length - 1].id;
      // ORM relation `none` filters generate NOT IN subplans which can scan
      // millions of unrelated ledger rows even when the outer IDs are bound.
      // Materialize this window and probe each child's batch index instead.
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        gustoApiHandoffCandidatesSql(candidateWindow.map((batch) => batch.id)),
      );
      const ids = locked.map((batch) => batch.id);
      if (!ids.length) continue;
      // Recheck every scalar and relation guard after locking. Acquired data
      // and live work can never be relabelled as an empty browser handoff.
      const routedRows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "AtsIngestionBatch" batch
        SET status = 'routed', "lastError" = ${GUSTO_API_HANDOFF_REASON},
            "nextAcquireAt" = NULL, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE batch.id IN (${Prisma.join(ids)}) AND ${gustoApiHandoffGuardSql()}
        RETURNING batch.id
      `;
      await tx.atsEndpointSweepReceipt.updateMany({
        where: { batchId: { in: routedRows.map((batch) => batch.id) }, processedAt: null, state: { not: 'succeeded' } },
        data: { state: 'failed', outcome: 'routed_to_paid_search', safetyBlockReason: GUSTO_API_HANDOFF_REASON },
      });
      return routedRows.length;
    }
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
