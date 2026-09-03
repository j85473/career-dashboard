// Shared deployment logic extracted unchanged from deploy.sh.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const gateMode = process.env.QUIESCENCE_GATE_MODE;

function count(row) {
  return Number(row?.count || 0);
}

async function main() {
  const [pipelineRows, jobRows, contextRows, schemaRows] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "PipelineState"
      WHERE "isRunning" = true OR "lockToken" IS NOT NULL
    `),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "Job"
      WHERE "batchJobId" IS NOT NULL
         OR "jdBatchId" IS NOT NULL
         OR "afBatchId" IS NOT NULL
         OR "contextBatchId" IS NOT NULL
         OR "scoringStatus" = 'scoring'
    `),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "ContextProfile"
      WHERE "batchJobId" IS NOT NULL OR "linkedinBatchId" IS NOT NULL
    `),
    prisma.$queryRawUnsafe(`
      SELECT
        to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask",
        to_regclass('"ScoringBatch"') IS NOT NULL AS "scoringBatch",
        to_regclass('"AtsIngestionBatch"') IS NOT NULL AS "atsIngestionBatch",
        to_regclass('"AtsBoardCheckAttempt"') IS NOT NULL AS "atsBoardCheckAttempt",
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ProviderCircuit' AND column_name = 'requestLeaseToken'
        ) AS "providerRequestLease",
        to_regclass('"AtsAcquisitionWorkerSlot"') IS NOT NULL AS "atsWorkerSlot"
    `),
  ]);
  const ingestionRows = schemaRows[0]?.ingestionTask
    ? await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS count
        FROM "IngestionTask"
        WHERE "leaseToken" IS NOT NULL OR status = 'running'
      `)
    : [{ count: 0 }];
  // A manual scoring lease is held by Joseph, not by a process this deployment
  // is about to stop. Counting it made a release wait on a person: on
  // 2026-09-03 a deploy sat in this loop with five leased batches and nothing
  // else outstanding, looked hung, was cancelled mid-flight, and took the
  // Dashboard down for the length of a 5 GB backup.
  //
  // A release swap does not touch a batch. The rows stay, the export on the
  // Desktop stays, and an item whose lease lapses simply becomes leasable
  // again. What it does cost: an import landing inside the swap window fails
  // and has to be retried. That is a retry, against waiting on a human.
  //
  // Strict mode is unchanged and still refuses to proceed with any batch
  // outstanding, including merely exported ones. That is the mode for
  // operations that must not run beside manual scoring at all.
  const scoringRows = schemaRows[0]?.scoringBatch && gateMode === 'strict'
    ? await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS count
        FROM "ScoringBatch" b
        WHERE b.status IN ('exported', 'superseded')
          OR EXISTS (SELECT 1 FROM "ScoringBatchItem" i WHERE i."batchId" = b.id AND i.status = 'leased')
      `)
    : [{ count: 0 }];
  const atsBatchRows = schemaRows[0]?.atsIngestionBatch
    ? await prisma.$queryRawUnsafe(`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE (batch.status = 'processing' OR batch."leaseToken" IS NOT NULL)
              AND batch."leaseToken" IS NOT NULL
              AND batch."leaseExpiresAt" > params."utcNow"
          )::bigint AS "liveCount",
          COUNT(*) FILTER (
            WHERE (batch.status = 'processing' OR batch."leaseToken" IS NOT NULL)
              AND (
                batch."leaseToken" IS NULL
                OR batch."leaseExpiresAt" IS NULL
                OR batch."leaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleCount"
        FROM "AtsIngestionBatch" batch, params
      `)
    : [{ liveCount: 0, staleCount: 0 }];
  const atsAttemptRows = schemaRows[0]?.atsBoardCheckAttempt
    ? await prisma.$queryRawUnsafe(`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE attempt.outcome = 'running'
              AND attempt."leaseOwner" IS NOT NULL
              AND attempt."leaseExpiresAt" > params."utcNow"
          )::bigint AS "liveCount",
          COUNT(*) FILTER (
            WHERE attempt.outcome = 'running'
              AND (
                attempt."leaseOwner" IS NULL
                OR attempt."leaseExpiresAt" IS NULL
                OR attempt."leaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleCount"
        FROM "AtsBoardCheckAttempt" attempt, params
      `)
    : [{ liveCount: 0, staleCount: 0 }];
  const providerRequestRows = schemaRows[0]?.providerRequestLease
    ? await prisma.$queryRawUnsafe(`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE circuit."requestLeaseToken" IS NOT NULL
              AND circuit."requestLeaseOwner" IS NOT NULL
              AND circuit."requestLeaseExpiresAt" > params."utcNow"
          )::bigint AS "liveCount",
          COUNT(*) FILTER (
            WHERE circuit."requestLeaseToken" IS NOT NULL
              AND (
                circuit."requestLeaseOwner" IS NULL
                OR circuit."requestLeaseExpiresAt" IS NULL
                OR circuit."requestLeaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleCount"
        FROM "ProviderCircuit" circuit, params
    `)
    : [{ liveCount: 0, staleCount: 0 }];
  const atsWorkerSlotRows = schemaRows[0]?.atsWorkerSlot
    ? await prisma.$queryRawUnsafe(`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE slot."leaseToken" IS NOT NULL
              AND slot."leaseExpiresAt" > params."utcNow"
          )::bigint AS "liveCount",
          COUNT(*) FILTER (
            WHERE slot."leaseToken" IS NOT NULL
              AND (slot."leaseExpiresAt" IS NULL OR slot."leaseExpiresAt" <= params."utcNow")
          )::bigint AS "staleCount"
        FROM "AtsAcquisitionWorkerSlot" slot, params
      `)
    : [{ liveCount: 0, staleCount: 0 }];
  const active = {
    pipelineStates: count(pipelineRows[0]),
    manualScoringBatches: count(scoringRows[0]),
    jobLeases: count(jobRows[0]),
    contextLeases: count(contextRows[0]),
    ingestionLeases: count(ingestionRows[0]),
    atsBatchLeases: count({ count: atsBatchRows[0]?.liveCount }),
    staleAtsBatchLeases: count({ count: atsBatchRows[0]?.staleCount }),
    atsAttemptLeases: count({ count: atsAttemptRows[0]?.liveCount }),
    staleAtsAttemptLeases: count({ count: atsAttemptRows[0]?.staleCount }),
    providerRequestLeases: count({ count: providerRequestRows[0]?.liveCount }),
    staleProviderRequestLeases: count({ count: providerRequestRows[0]?.staleCount }),
    atsWorkerSlots: count({ count: atsWorkerSlotRows[0]?.liveCount }),
    staleAtsWorkerSlots: count({ count: atsWorkerSlotRows[0]?.staleCount }),
  };
  process.stdout.write(`${JSON.stringify(active)}\n`);
  if (Object.values(active).some((value) => value !== 0)) {
    throw new Error(`${gateMode} quiescence gate failed: active database work remains`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
