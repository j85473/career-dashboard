// Shared deployment logic extracted unchanged from deploy.sh.
const { PrismaClient } = require('@prisma/client');
const os = require('node:os');
const prisma = new PrismaClient();
const PIPELINE_LOCK_STALE_MS = 5 * 60 * 1000;

function count(row) {
  return Number(row?.count || 0);
}

function localOwnerPid(owner) {
  const prefix = `${os.hostname()}:`;
  if (typeof owner !== 'string' || !owner.startsWith(prefix)) return null;
  const rawPid = owner.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(rawPid)) return null;
  const pid = Number(rawPid);
  return Number.isSafeInteger(pid) ? pid : null;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function main() {
  const [schemaRows] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT
        to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask",
        to_regclass('"AtsIngestionBatch"') IS NOT NULL AS "atsIngestionBatch",
        to_regclass('"AtsBoardCheckAttempt"') IS NOT NULL AS "atsBoardCheckAttempt",
        to_regclass('"AtsAcquisitionWorkerSlot"') IS NOT NULL AS "atsWorkerSlot"
    `),
  ]);
  if (!schemaRows[0]?.atsBoardCheckAttempt) {
    process.stdout.write('ATS attempt reclaim skipped: this release predates AtsBoardCheckAttempt.\n');
    return;
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PIPELINE_LOCK_STALE_MS);
  const pipeline = await prisma.pipelineState.findUnique({
    where: { id: 'global' },
    select: { lockToken: true, lockOwner: true, lockHeartbeatAt: true },
  });
  if (
    pipeline?.lockToken
    && (pipeline.lockHeartbeatAt == null || pipeline.lockHeartbeatAt <= staleBefore)
  ) {
    const cleared = await prisma.pipelineState.updateMany({
      where: {
        id: 'global',
        lockToken: pipeline.lockToken,
        lockOwner: pipeline.lockOwner,
        OR: [
          { lockHeartbeatAt: null },
          { lockHeartbeatAt: { lte: staleBefore } },
        ],
      },
      data: { lockToken: null, lockOwner: null, lockHeartbeatAt: null },
    });
    if (cleared.count === 1) {
      process.stdout.write('Reclaimed one stale pipeline lock after its five-minute heartbeat boundary.\n');
    }
  }
  if (schemaRows[0]?.ingestionTask) {
    const ingestionTasks = await prisma.ingestionTask.findMany({
      where: { OR: [{ leaseToken: { not: null } }, { status: 'running' }] },
      select: {
        id: true,
        taskKey: true,
        status: true,
        leaseToken: true,
        leaseOwner: true,
        leaseStartedAt: true,
        heartbeatAt: true,
        leaseExpiresAt: true,
      },
    });
    let reclaimedIngestionTasks = 0;
    for (const task of ingestionTasks) {
      const pid = localOwnerPid(task.leaseOwner);
      const localOwnerExited = pid != null && !processExists(pid);
      const leaseExpired = task.leaseExpiresAt == null || task.leaseExpiresAt <= now;
      if (!localOwnerExited && !leaseExpired) continue;
      const reclaimed = await prisma.ingestionTask.updateMany({
        where: {
          id: task.id,
          status: task.status,
          leaseToken: task.leaseToken,
          leaseOwner: task.leaseOwner,
          leaseStartedAt: task.leaseStartedAt,
          heartbeatAt: task.heartbeatAt,
          leaseExpiresAt: task.leaseExpiresAt,
        },
        data: {
          status: 'partial',
          nextRunAt: now,
          heartbeatAt: now,
          leaseToken: null,
          leaseOwner: null,
          leaseStartedAt: null,
          leaseExpiresAt: null,
          lastError: 'Ingestion owner exited before deployment; durable batches retain their checkpoints.',
        },
      });
      reclaimedIngestionTasks += reclaimed.count;
    }
    if (reclaimedIngestionTasks > 0) {
      process.stdout.write(
        `Reclaimed ${reclaimedIngestionTasks} orphaned ingestion task lease(s); durable counters and cursors remain.\n`,
      );
    }
  }
  const pipelineRows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS count
    FROM "PipelineState"
    WHERE "isRunning" = true OR "lockToken" IS NOT NULL
  `);
  const ingestionRows = schemaRows[0]?.ingestionTask
    ? await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS count
        FROM "IngestionTask"
        WHERE "leaseToken" IS NOT NULL OR status = 'running'
      `)
    : [{ count: 0 }];
  const workerRows = schemaRows[0]?.atsWorkerSlot
    ? await prisma.$queryRawUnsafe(`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT COUNT(*)::bigint AS count
        FROM "AtsAcquisitionWorkerSlot" slot, params
        WHERE slot."leaseToken" IS NOT NULL
          AND slot."leaseExpiresAt" > params."utcNow"
      `)
    : [{ count: 0 }];
  const owners = count(pipelineRows[0]) + count(ingestionRows[0]) + count(workerRows[0]);
  if (owners > 0) {
    process.stdout.write(
      `ATS attempt reclaim skipped: ${owners} pipeline, ingestion, or ATS worker owner(s) still hold production work.\n`,
    );
    return;
  }
  const staleBatches = schemaRows[0]?.atsIngestionBatch
    ? await prisma.atsIngestionBatch.findMany({
        where: {
          writerMode: 'legacy',
          OR: [{ status: 'processing' }, { leaseToken: { not: null } }],
          AND: [{
            OR: [
              { leaseToken: null },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: now } },
            ],
          }],
        },
        select: {
          id: true,
          status: true,
          leaseToken: true,
          leaseOwner: true,
          leaseStartedAt: true,
          heartbeatAt: true,
          leaseExpiresAt: true,
        },
      })
    : [];
  let reclaimedBatches = 0;
  for (const batch of staleBatches) {
    const reclaimed = await prisma.atsIngestionBatch.updateMany({
      where: {
        id: batch.id,
        writerMode: 'legacy',
        status: batch.status,
        leaseToken: batch.leaseToken,
        leaseOwner: batch.leaseOwner,
        leaseStartedAt: batch.leaseStartedAt,
        heartbeatAt: batch.heartbeatAt,
        leaseExpiresAt: batch.leaseExpiresAt,
      },
      data: {
        status: 'queued',
        nextProcessAt: now,
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        lastError: 'Persistence owner exited before deployment; durable payload, cursor, offset, and counters remain.',
      },
    });
    reclaimedBatches += reclaimed.count;
  }
  if (reclaimedBatches > 0) {
    process.stdout.write(
      `Reclaimed ${reclaimedBatches} orphaned ATS persistence batch lease(s); durable payloads and checkpoints remain.\n`,
    );
  }
  const reclaimed = await prisma.atsBoardCheckAttempt.updateMany({
    where: { outcome: 'running' },
    data: {
      outcome: 'interrupted',
      heartbeatAt: now,
      leaseExpiresAt: null,
      finishedAt: now,
      error: 'Acquisition attempt was orphaned before a deploy; the durable batch will resume from its last cursor.',
    },
  });
  process.stdout.write(
    reclaimed.count > 0
      ? `Reclaimed ${reclaimed.count} orphaned ATS board check attempt(s); their batches keep their cursors.\n`
      : 'No orphaned ATS board check attempts remained.\n',
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
