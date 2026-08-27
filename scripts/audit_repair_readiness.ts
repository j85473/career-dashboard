import 'dotenv/config';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import * as mammoth from 'mammoth';

import { buildIngestionTaskKey } from '../src/lib/ingestionControl';
import {
  canonicalIngestionTaskDefinitions,
  configuredIngestionTaskCatalogOptions,
} from '../src/lib/ingestionTaskCatalog';

const prisma = new PrismaClient();
const CANONICAL_RESUME = path.resolve('data/resumes/JosephLamb_Resume.docx');
const CANONICAL_SHA256 = '9ad3e6c9db671d455aab2d903d3d662e81d385883a436663b597286850c77640';
const CANONICAL_TITLE = 'Field Sales Representative — Channel Sales';
const INVALID_PROMPT_VERSION = 'standard-job-evaluator-v6.7.1';

type Arguments = {
  strict: boolean;
  expectRepairApplied: boolean;
  expectTasksSeeded: boolean;
};

function parseArguments(argv: string[]): Arguments {
  const args: Arguments = {
    strict: false,
    expectRepairApplied: false,
    expectTasksSeeded: false,
  };
  for (const argument of argv) {
    if (argument === '--strict') args.strict = true;
    else if (argument === '--expect-repair-applied') args.expectRepairApplied = true;
    else if (argument === '--expect-tasks-seeded') args.expectTasksSeeded = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return args;
}

function asNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function inspectCanonicalResume() {
  if (!fs.existsSync(CANONICAL_RESUME)) {
    return {
      ok: false,
      path: path.relative(process.cwd(), CANONICAL_RESUME),
      error: 'missing',
    };
  }
  const bytes = fs.readFileSync(CANONICAL_RESUME);
  const actualHash = sha256(bytes);
  const text = (await mammoth.extractRawText({ buffer: bytes })).value.replace(/\s+/g, ' ').trim();
  return {
    ok: actualHash === CANONICAL_SHA256
      && text.includes(CANONICAL_TITLE)
      && !text.includes('Channel Account Manager'),
    path: path.relative(process.cwd(), CANONICAL_RESUME),
    expectedHash: CANONICAL_SHA256,
    actualHash,
    canonicalTitlePresent: text.includes(CANONICAL_TITLE),
    substitutedTitleAbsent: !text.includes('Channel Account Manager'),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const canonicalResume = await inspectCanonicalResume();
  const [schemaRow] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask",
      to_regclass('"ProviderCircuit"') IS NOT NULL AS "providerCircuit",
      to_regclass('"ProviderIncident"') IS NOT NULL AS "providerIncident",
      to_regclass('"JobPipelineEvent"') IS NOT NULL AS "jobPipelineEvent",
      to_regclass('"ContextRule"') IS NOT NULL AS "contextRule",
      to_regclass('"AtsIngestionBatch"') IS NOT NULL AS "atsIngestionBatch",
      to_regclass('"AtsBoardCheckAttempt"') IS NOT NULL AS "atsBoardCheckAttempt",
      NOT EXISTS (
        SELECT 1
        FROM (VALUES
          ('id'), ('slug'), ('platform'), ('status'), ('payload'), ('payloadHash'),
          ('metadata'), ('cursor'), ('requestCount'), ('pageCount'), ('jobCount'),
          ('insertedCount'), ('duplicateCount'), ('filteredCount'), ('processingErrorCount'),
          ('processingAttemptCount'), ('processingOffset'), ('nextProcessAt'), ('leaseToken'),
          ('leaseOwner'), ('leaseStartedAt'), ('heartbeatAt'), ('leaseExpiresAt'),
          ('startedAt'), ('respondedAt'), ('synchronizedAt'), ('processedAt'), ('lastError'),
          ('createdAt'), ('updatedAt')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns existing
          WHERE existing.table_schema = current_schema()
            AND existing.table_name = 'AtsIngestionBatch'
            AND existing.column_name = required.column_name
        )
      ) AS "atsBatchRuntimeColumns",
      NOT EXISTS (
        SELECT 1
        FROM (VALUES
          ('id'), ('slug'), ('platform'), ('batchId'), ('outcome'), ('leaseOwner'),
          ('heartbeatAt'), ('leaseExpiresAt'), ('httpStatus'), ('requestCount'), ('pageCount'),
          ('jobCount'), ('startedAt'), ('contactedAt'), ('respondedAt'), ('synchronizedAt'),
          ('processedAt'), ('finishedAt'), ('durationMs'), ('error'), ('createdAt')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns existing
          WHERE existing.table_schema = current_schema()
            AND existing.table_name = 'AtsBoardCheckAttempt'
            AND existing.column_name = required.column_name
        )
      ) AS "atsAttemptRuntimeColumns",
      NOT EXISTS (
        SELECT 1
        FROM (VALUES
          ('slug'), ('platform'), ('status'), ('failCount'), ('retryCount'), ('nextCheckDate'),
          ('checkDay'), ('lastCheckedAt'), ('lastAttemptedAt'), ('lastRespondedAt'),
          ('lastSynchronizedAt'), ('lastProcessedAt'), ('jobsFound'), ('discoveredAt')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns existing
          WHERE existing.table_schema = current_schema()
            AND existing.table_name = 'AtsCompany'
            AND existing.column_name = required.column_name
        )
      ) AS "atsCompanyRuntimeColumns",
      NOT EXISTS (
        SELECT 1
        FROM (VALUES
          ('provider'), ('state'), ('openUntil'), ('consecutiveFailures'), ('dailyLimit'),
          ('monthlyLimit'), ('dailyUsed'), ('monthlyUsed'), ('budgetDay'), ('budgetMonth'),
          ('lastError'), ('lastFailureAt'), ('lastSuccessAt'), ('requestLeaseToken'),
          ('requestLeaseOwner'), ('requestLeaseExpiresAt'), ('updatedAt')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns existing
          WHERE existing.table_schema = current_schema()
            AND existing.table_name = 'ProviderCircuit'
            AND existing.column_name = required.column_name
        )
      ) AS "providerRequestLeaseColumns",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'JobScoreEvent' AND column_name = 'staleAt'
      ) AS "scoreStaleness",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'IngestionTask' AND column_name = 'taskKind'
      ) AS "ingestionTaskLifecycle";
  `;
  const schema = {
    ingestionTask: schemaRow?.ingestionTask === true,
    providerCircuit: schemaRow?.providerCircuit === true,
    providerIncident: schemaRow?.providerIncident === true,
    jobPipelineEvent: schemaRow?.jobPipelineEvent === true,
    contextRule: schemaRow?.contextRule === true,
    atsIngestionBatch: schemaRow?.atsIngestionBatch === true,
    atsBoardCheckAttempt: schemaRow?.atsBoardCheckAttempt === true,
    atsBatchRuntimeColumns: schemaRow?.atsBatchRuntimeColumns === true,
    atsAttemptRuntimeColumns: schemaRow?.atsAttemptRuntimeColumns === true,
    atsCompanyRuntimeColumns: schemaRow?.atsCompanyRuntimeColumns === true,
    providerRequestLeaseColumns: schemaRow?.providerRequestLeaseColumns === true,
    scoreStaleness: schemaRow?.scoreStaleness === true,
    ingestionTaskLifecycle: schemaRow?.ingestionTaskLifecycle === true,
  };
  const schemaReady = Object.values(schema).every(Boolean);

  const [legacyQueueRow] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      COUNT(*)::bigint AS "totalJobs",
      COUNT(*) FILTER (
        WHERE status IN ('pending_af', 'inbox')
          AND "tailoringStaged" = false
          AND "batchJobId" IS NULL
          AND "jdBatchId" IS NULL
          AND "afBatchId" IS NULL
          AND (
            "scoringStatus" IN ('failed', 'skipped')
            OR "scoreAttempts" >= 6
            OR ("aimFitScore" IS NOT NULL AND "experienceStatus" NOT IN ('queued', 'rescore_queued', 'scored'))
          )
      )::bigint AS "activeOrphans",
      COUNT(*) FILTER (
        WHERE status = 'pending_af' AND "scoringStatus" = 'needs_jd'
      )::bigint AS "needsJd",
      COUNT(*) FILTER (
        WHERE status = 'pending_af' AND "scoringStatus" = 'scored' AND "aimFitScore" IS NULL
      )::bigint AS "awaitingNative"
    FROM "Job";
  `;

  const [
    nativeRequestRows,
    scoringLeaseRows,
    contextLeaseRows,
    pipelineLockRows,
    atsBatchLeaseRows,
    atsAttemptLeaseRows,
    providerRequestLeaseRows,
  ] = await Promise.all([
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        COUNT(*) FILTER (WHERE "activeKey" IS NOT NULL)::bigint AS "activeRequests",
        COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
        COUNT(*) FILTER (WHERE status = 'running')::bigint AS running,
        COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::bigint AS "nonterminalRequests",
        COUNT(*) FILTER (WHERE status = 'failed' AND "activeKey" IS NOT NULL)::bigint AS "failedSingleFlight"
      FROM "NativeScoringRequest";
    `,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        COUNT(*) FILTER (WHERE "batchJobId" IS NOT NULL)::bigint AS "localScoringLeases",
        COUNT(*) FILTER (WHERE "scoringStatus" = 'scoring')::bigint AS "localScoringStates",
        COUNT(*) FILTER (WHERE "jdBatchId" IS NOT NULL)::bigint AS "jdExtractionLeases",
        COUNT(*) FILTER (WHERE "afBatchId" IS NOT NULL)::bigint AS "nativeJobLeases",
        COUNT(*) FILTER (WHERE "contextBatchId" IS NOT NULL)::bigint AS "contextJobLeases"
      FROM "Job";
    `,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        COUNT(*) FILTER (WHERE "batchJobId" IS NOT NULL)::bigint AS "contextProfileBatchLeases",
        COUNT(*) FILTER (WHERE "linkedinBatchId" IS NOT NULL)::bigint AS "contextProfileLinkedinLeases"
      FROM "ContextProfile";
    `,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        COUNT(*) FILTER (WHERE "lockToken" IS NOT NULL)::bigint AS "pipelineLocks",
        COUNT(*) FILTER (WHERE "isRunning" = true)::bigint AS "runningPipelineStates",
        COUNT(*) FILTER (
          WHERE "lockToken" IS NOT NULL
            AND (
              "lockHeartbeatAt" IS NULL
              OR "lockHeartbeatAt" < NOW() - INTERVAL '5 minutes'
            )
        )::bigint AS "stalePipelineLocks"
      FROM "PipelineState";
    `,
    schema.atsIngestionBatch && schema.atsBatchRuntimeColumns
      ? prisma.$queryRaw<Array<Record<string, unknown>>>`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE (batch.status = 'processing' OR batch."leaseToken" IS NOT NULL)
              AND batch."leaseToken" IS NOT NULL
              AND batch."leaseExpiresAt" > params."utcNow"
          )::bigint AS "liveAtsBatchLeases",
          COUNT(*) FILTER (
            WHERE (batch.status = 'processing' OR batch."leaseToken" IS NOT NULL)
              AND (
                batch."leaseToken" IS NULL
                OR batch."leaseExpiresAt" IS NULL
                OR batch."leaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleAtsBatchLeases"
        FROM "AtsIngestionBatch" batch, params;
      `
      : Promise.resolve([{ liveAtsBatchLeases: 0, staleAtsBatchLeases: 0 }]),
    schema.atsBoardCheckAttempt && schema.atsAttemptRuntimeColumns
      ? prisma.$queryRaw<Array<Record<string, unknown>>>`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE attempt.outcome = 'running'
              AND attempt."leaseOwner" IS NOT NULL
              AND attempt."leaseExpiresAt" > params."utcNow"
          )::bigint AS "liveAtsAttemptLeases",
          COUNT(*) FILTER (
            WHERE attempt.outcome = 'running'
              AND (
                attempt."leaseOwner" IS NULL
                OR attempt."leaseExpiresAt" IS NULL
                OR attempt."leaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleAtsAttemptLeases"
        FROM "AtsBoardCheckAttempt" attempt, params;
      `
      : Promise.resolve([{ liveAtsAttemptLeases: 0, staleAtsAttemptLeases: 0 }]),
    schema.providerRequestLeaseColumns
      ? prisma.$queryRaw<Array<Record<string, unknown>>>`
        WITH params AS (
          SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE circuit."requestLeaseToken" IS NOT NULL
              AND circuit."requestLeaseOwner" IS NOT NULL
              AND circuit."requestLeaseExpiresAt" > params."utcNow"
          )::bigint AS "liveProviderRequestLeases",
          COUNT(*) FILTER (
            WHERE circuit."requestLeaseToken" IS NOT NULL
              AND (
                circuit."requestLeaseOwner" IS NULL
                OR circuit."requestLeaseExpiresAt" IS NULL
                OR circuit."requestLeaseExpiresAt" <= params."utcNow"
              )
          )::bigint AS "staleProviderRequestLeases"
        FROM "ProviderCircuit" circuit, params;
      `
      : Promise.resolve([{ liveProviderRequestLeases: 0, staleProviderRequestLeases: 0 }]),
  ]);
  const leases = {
    nativeRequests: Object.fromEntries(Object.entries(nativeRequestRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    scoringJobs: Object.fromEntries(Object.entries(scoringLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    contextProfiles: Object.fromEntries(Object.entries(contextLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    pipeline: Object.fromEntries(Object.entries(pipelineLockRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    atsBatches: Object.fromEntries(Object.entries(atsBatchLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    atsAttempts: Object.fromEntries(Object.entries(atsAttemptLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    providerRequests: Object.fromEntries(Object.entries(providerRequestLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
  };

  let scores: Record<string, number> = {
    invalidVersionCurrent: 0,
    invalidVersionStale: 0,
    currentIncompletePasses: 0,
  };
  if (schema.scoreStaleness) {
    const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      WITH latest_current_score AS (
        SELECT
          events.*,
          ROW_NUMBER() OVER (PARTITION BY events."jobId" ORDER BY events."createdAt" DESC, events.id DESC) AS rank
        FROM "JobScoreEvent" events
        WHERE events."evaluationType" IN ('standard', 'ae_fit')
      )
      SELECT
        COUNT(*) FILTER (
          WHERE "promptVersion" = ${INVALID_PROMPT_VERSION} AND "staleAt" IS NULL
        )::bigint AS "invalidVersionCurrent",
        COUNT(*) FILTER (
          WHERE "promptVersion" = ${INVALID_PROMPT_VERSION} AND "staleAt" IS NOT NULL
        )::bigint AS "invalidVersionStale",
        (
          SELECT COUNT(*)::bigint
          FROM latest_current_score latest
          JOIN "Job" job ON job.id = latest."jobId"
          WHERE latest.rank = 1
            AND latest."staleAt" IS NULL
            AND latest.passed = true
            AND job.status = 'inbox'
            AND CASE
              WHEN latest."mandatoryRequirementAssessments" IS NULL THEN true
              WHEN jsonb_typeof(latest."mandatoryRequirementAssessments") <> 'array' THEN true
              ELSE jsonb_array_length(latest."mandatoryRequirementAssessments") = 0
            END
        ) AS "currentIncompletePasses"
      FROM "JobScoreEvent" events;
    `;
    scores = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, asNumber(value)]));
  } else {
    const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      WITH latest_current_score AS (
        SELECT
          events.*,
          ROW_NUMBER() OVER (PARTITION BY events."jobId" ORDER BY events."createdAt" DESC, events.id DESC) AS rank
        FROM "JobScoreEvent" events
        WHERE events."evaluationType" IN ('standard', 'ae_fit')
      )
      SELECT
        COUNT(*) FILTER (
          WHERE "promptVersion" = ${INVALID_PROMPT_VERSION}
        )::bigint AS "invalidVersionCurrent",
        0::bigint AS "invalidVersionStale",
        (
          SELECT COUNT(*)::bigint
          FROM latest_current_score latest
          JOIN "Job" job ON job.id = latest."jobId"
          WHERE latest.rank = 1
            AND latest.passed = true
            AND job.status = 'inbox'
            AND CASE
              WHEN latest."mandatoryRequirementAssessments" IS NULL THEN true
              WHEN jsonb_typeof(latest."mandatoryRequirementAssessments") <> 'array' THEN true
              ELSE jsonb_array_length(latest."mandatoryRequirementAssessments") = 0
            END
        ) AS "currentIncompletePasses"
      FROM "JobScoreEvent" events;
    `;
    scores = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, asNumber(value)]));
  }

  let ingestion: Record<string, unknown> = { available: false };
  if (schema.ingestionTask) {
    const atsPlatformRows = await prisma.atsCompany.findMany({
      select: { platform: true },
      distinct: ['platform'],
      orderBy: { platform: 'asc' },
    });
    const expectedTaskKeys = [...new Set(canonicalIngestionTaskDefinitions(
      configuredIngestionTaskCatalogOptions(
        process.env,
        atsPlatformRows.map((row) => row.platform),
      ),
    ).map((definition) => buildIngestionTaskKey(definition.spec)))].sort();
    const taskAudit = schema.ingestionTaskLifecycle
      ? prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*)::bigint AS "taskCount",
          COUNT(*) FILTER (WHERE task."taskKind" = 'search' AND task."lifecycleStatus" = 'active')::bigint AS "activeSearchTasks",
          COUNT(*) FILTER (WHERE task."taskKind" = 'orchestration')::bigint AS orchestration,
          COUNT(*) FILTER (WHERE task."lifecycleStatus" = 'retired')::bigint AS retired,
          COUNT(*) FILTER (
            WHERE task."taskKind" = 'search' AND task."lifecycleStatus" = 'active'
              AND task."nextRunAt" <= NOW()
          )::bigint AS overdue,
          COUNT(*) FILTER (WHERE task."leaseExpiresAt" < NOW() AND task."leaseToken" IS NOT NULL)::bigint AS "staleLeases",
          COUNT(*) FILTER (WHERE task."leaseToken" IS NOT NULL)::bigint AS "activeLeases",
          COUNT(*) FILTER (WHERE task.status = 'running')::bigint AS "runningTasks",
          COUNT(*) FILTER (
            WHERE task."seenCount" <> task."insertedCount" + task."duplicateCount" + task."filteredCount" + task."processingErrorCount"
          )::bigint AS "counterMismatches",
          COUNT(*) FILTER (
            WHERE task."taskKind" = 'search' AND task."lifecycleStatus" = 'active'
              AND task.status = 'succeeded'
              AND task."lastCompletedAt" IS NOT NULL
              AND task."nextRunAt" < task."lastCompletedAt" - INTERVAL '1 second'
          )::bigint AS "successScheduledBeforeCompletion",
          COUNT(*) FILTER (
            WHERE task."taskKind" = 'search' AND task."lifecycleStatus" = 'active'
              AND task.status = 'blocked_circuit'
              AND circuit."openUntil" IS NOT NULL
              AND task."nextRunAt" < circuit."openUntil"
          )::bigint AS "blockedBeforeProviderRetry"
        FROM "IngestionTask" task
        LEFT JOIN "ProviderCircuit" circuit ON circuit.provider = task.source;
      `
      : prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*)::bigint AS "taskCount",
          COUNT(*) FILTER (WHERE "nextRunAt" <= NOW())::bigint AS overdue,
          COUNT(*) FILTER (WHERE "leaseExpiresAt" < NOW() AND "leaseToken" IS NOT NULL)::bigint AS "staleLeases",
          COUNT(*) FILTER (WHERE "leaseToken" IS NOT NULL)::bigint AS "activeLeases",
          COUNT(*) FILTER (WHERE status = 'running')::bigint AS "runningTasks",
          COUNT(*) FILTER (
            WHERE "seenCount" <> "insertedCount" + "duplicateCount" + "filteredCount" + "processingErrorCount"
          )::bigint AS "counterMismatches"
        FROM "IngestionTask";
      `;
    const [taskRow, runRow, atsRow, seededTaskRows, taskStatusRows, oldestRunnableRows, atsDuePlatformRows, atsThroughputRows, needsJdRows] = await Promise.all([
      taskAudit,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*)::bigint AS "runs7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NOT NULL
          )::bigint AS "durableRuns7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NOT NULL AND reconciled = true
          )::bigint AS "durableReconciledRuns7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NOT NULL AND reconciled = false
          )::bigint AS "durableUnreconciledRuns7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NULL AND reconciled = false
          )::bigint AS "legacyUnreconciledEvidence7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NOT NULL
              AND reconciled = true
              AND "seenCount" <> "insertedCount" + "duplicateCount" + "filteredCount" + "processingErrorCount"
          )::bigint AS "durableCounterMismatches7d",
          COUNT(*) FILTER (
            WHERE checkpoint IS NULL
              AND "seenCount" <> "insertedCount" + "duplicateCount" + "filteredCount" + "processingErrorCount"
          )::bigint AS "legacyCounterEquationGaps7d",
          COALESCE(SUM("requestErrorCount") FILTER (WHERE checkpoint IS NOT NULL), 0)::bigint AS "requestErrors7d",
          COALESCE(SUM("processingErrorCount") FILTER (WHERE checkpoint IS NOT NULL), 0)::bigint AS "processingErrors7d"
        FROM "IngestionSourceRun"
        WHERE "createdAt" >= NOW() - INTERVAL '7 days';
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::bigint AS active,
          COUNT(*) FILTER (WHERE status = 'active' AND "nextCheckDate" <= NOW())::bigint AS due,
          COUNT(*) FILTER (WHERE status <> 'active')::bigint AS inactive
        FROM "AtsCompany";
      `,
      prisma.ingestionTask.findMany({
        where: { taskKey: { in: expectedTaskKeys } },
        select: { taskKey: true },
      }),
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT status, COUNT(*)::bigint AS count,
          COUNT(*) FILTER (
            WHERE "nextRunAt" <= NOW() AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= NOW())
          )::bigint AS runnable
        FROM "IngestionTask"
        GROUP BY status ORDER BY status;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT source, MIN("nextRunAt") AS "oldestRunnableSince", COUNT(*)::bigint AS runnable
        FROM "IngestionTask"
        WHERE "nextRunAt" <= NOW() AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= NOW())
        GROUP BY source ORDER BY MIN("nextRunAt") ASC LIMIT 50;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT platform,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE "nextCheckDate" <= NOW())::bigint AS due,
          MIN("nextCheckDate") FILTER (WHERE "nextCheckDate" <= NOW()) AS "oldestDueAt"
        FROM "AtsCompany"
        WHERE status IN ('active', 'parked', 'blacklisted')
        GROUP BY platform ORDER BY due DESC, platform;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT source,
          COUNT(*)::bigint AS runs,
          ROUND(AVG("durationMs"))::bigint AS "averageDurationMs",
          COALESCE(SUM("seenCount"), 0)::bigint AS seen,
          CASE WHEN SUM("durationMs") > 0
            THEN ROUND((SUM("seenCount")::numeric * 3600000) / SUM("durationMs"), 2)
            ELSE NULL END AS "seenPerHour"
        FROM "IngestionSourceRun"
        WHERE source LIKE 'ATS-%' AND "startedAt" >= NOW() - INTERVAL '7 days'
        GROUP BY source ORDER BY runs DESC, source;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          (SELECT COUNT(*) FROM "Job" WHERE "scoringStatus" = 'needs_jd' AND status IN ('pending_af', 'inbox'))::bigint AS "currentBacklog",
          COUNT(*) FILTER (
            WHERE "eventType" = 'ingested' AND details @> '{"needsJd": true}'::jsonb
              AND "occurredAt" >= NOW() - INTERVAL '24 hours'
          )::bigint AS "arrivals24h",
          COUNT(*) FILTER (
            WHERE "eventType" = 'jd_ready' AND "occurredAt" >= NOW() - INTERVAL '24 hours'
          )::bigint AS "drained24h"
        FROM "JobPipelineEvent";
      `,
    ]);
    const seededTaskKeys = new Set(seededTaskRows.map((task) => task.taskKey));
    const missingTaskKeys = expectedTaskKeys.filter((taskKey) => !seededTaskKeys.has(taskKey));
    ingestion = {
      available: true,
      tasks: Object.fromEntries(Object.entries(taskRow[0] || {}).map(([key, value]) => [key, asNumber(value)])),
      runs: Object.fromEntries(Object.entries(runRow[0] || {}).map(([key, value]) => [key, asNumber(value)])),
      atsBoards: Object.fromEntries(Object.entries(atsRow[0] || {}).map(([key, value]) => [key, asNumber(value)])),
      catalog: {
        expectedTaskCount: expectedTaskKeys.length,
        seededTaskCount: seededTaskRows.length,
        missingTaskKeys,
      },
      statusBreakdown: taskStatusRows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
      oldestRunnableBySource: oldestRunnableRows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
      atsDueByPlatform: atsDuePlatformRows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
      atsThroughput7d: atsThroughputRows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
      needsJd: Object.fromEntries(Object.entries(needsJdRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    };
  }

  let operations: Record<string, unknown> = { available: false };
  if (schema.jobPipelineEvent && schema.providerCircuit && schema.providerIncident && schema.contextRule) {
    const [eventRows, circuitRows, incidentRows, contextRows] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          "eventType",
          COUNT(*)::bigint AS count
        FROM "JobPipelineEvent"
        WHERE "occurredAt" >= NOW() - INTERVAL '30 days'
        GROUP BY "eventType"
        ORDER BY "eventType";
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT provider, state, "openUntil", "dailyUsed", "dailyLimit", "monthlyUsed", "monthlyLimit"
        FROM "ProviderCircuit"
        WHERE state <> 'closed'
           OR ("dailyLimit" IS NOT NULL AND "dailyUsed" >= "dailyLimit")
           OR ("monthlyLimit" IS NOT NULL AND "monthlyUsed" >= "monthlyLimit")
        ORDER BY provider;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT provider, classification, status, "affectedQueryCount", "occurrenceCount", "lastSeenAt"
        FROM "ProviderIncident"
        WHERE status = 'open'
        ORDER BY "lastSeenAt" DESC;
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*) FILTER (WHERE active = true)::bigint AS active,
          COUNT(*) FILTER (WHERE active = false)::bigint AS retired,
          COUNT(*) FILTER (WHERE active = true AND scope <> 'aim_only')::bigint AS "invalidScope"
        FROM "ContextRule";
      `,
    ]);
    operations = {
      available: true,
      eventCounts30d: Object.fromEntries(eventRows.map((row) => [String(row.eventType), asNumber(row.count)])),
      circuitsRequiringAttention: circuitRows,
      openProviderIncidents: incidentRows,
      contextRules: Object.fromEntries(Object.entries(contextRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    };
  }

  const queue = Object.fromEntries(Object.entries(legacyQueueRow || {}).map(([key, value]) => [key, asNumber(value)]));
  const violations: string[] = [];
  if (!canonicalResume.ok) violations.push('canonical_resume_contract');
  if (!schemaReady) violations.push('repair_schema_not_applied');
  if ((queue.activeOrphans || 0) > 0) violations.push('active_scoring_orphans');
  if ((scores.currentIncompletePasses || 0) > 0) violations.push('current_incomplete_jd_passes');
  if (
    asNumber(leases.nativeRequests.activeRequests) > 0
    || asNumber(leases.nativeRequests.nonterminalRequests) > 0
  ) violations.push('active_native_scoring_requests');
  if (
    asNumber(leases.pipeline.pipelineLocks) > 0
    || asNumber(leases.pipeline.runningPipelineStates) > 0
  ) violations.push('active_pipeline_lock');
  if (asNumber(leases.atsBatches.liveAtsBatchLeases) > 0) violations.push('active_ats_batch_leases');
  if (asNumber(leases.atsBatches.staleAtsBatchLeases) > 0) violations.push('stale_ats_batch_leases');
  if (asNumber(leases.atsAttempts.liveAtsAttemptLeases) > 0) violations.push('active_ats_attempt_leases');
  if (asNumber(leases.atsAttempts.staleAtsAttemptLeases) > 0) violations.push('stale_ats_attempt_leases');
  if (asNumber(leases.providerRequests.liveProviderRequestLeases) > 0) violations.push('active_provider_request_leases');
  if (asNumber(leases.providerRequests.staleProviderRequestLeases) > 0) violations.push('stale_provider_request_leases');
  if (
    asNumber(leases.scoringJobs.localScoringLeases)
    + asNumber(leases.scoringJobs.localScoringStates)
    + asNumber(leases.scoringJobs.jdExtractionLeases)
    + asNumber(leases.scoringJobs.nativeJobLeases)
    + asNumber(leases.scoringJobs.contextJobLeases)
    + asNumber(leases.contextProfiles.contextProfileBatchLeases)
    + asNumber(leases.contextProfiles.contextProfileLinkedinLeases) > 0
  ) violations.push('active_scoring_leases');
  if (args.expectRepairApplied && (scores.invalidVersionCurrent || 0) > 0) violations.push('invalid_scores_not_stale');
  if (args.expectRepairApplied && (scores.invalidVersionStale || 0) === 0) violations.push('missing_stale_score_evidence');
  if (args.expectTasksSeeded && schema.ingestionTask) {
    const catalog = ingestion.catalog as Record<string, unknown> | undefined;
    if (
      asNumber(catalog?.expectedTaskCount) === 0
      || asNumber(catalog?.seededTaskCount) !== asNumber(catalog?.expectedTaskCount)
    ) violations.push('durable_tasks_not_seeded');
  }
  if (schema.ingestionTask) {
    const tasks = ingestion.tasks as Record<string, unknown>;
    const runs = ingestion.runs as Record<string, unknown>;
    if (
      asNumber(tasks?.activeLeases) > 0
      || asNumber(tasks?.runningTasks) > 0
    ) violations.push('active_ingestion_leases');
    if (asNumber(tasks?.staleLeases) > 0) violations.push('stale_ingestion_leases');
    if (asNumber(tasks?.counterMismatches) > 0) violations.push('task_counter_mismatch');
    if (asNumber(tasks?.successScheduledBeforeCompletion) > 0) violations.push('success_scheduled_before_completion');
    if (asNumber(tasks?.blockedBeforeProviderRetry) > 0) violations.push('blocked_before_provider_retry');
    if (asNumber(runs?.durableCounterMismatches7d) > 0) violations.push('source_run_counter_mismatch');
    if (asNumber(runs?.durableUnreconciledRuns7d) > 0) violations.push('durable_source_run_unreconciled');
  }
  if (schema.contextRule) {
    const contextRules = operations.contextRules as Record<string, unknown> | undefined;
    if (asNumber(contextRules?.invalidScope) > 0) violations.push('context_rule_scope_violation');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args,
    canonicalResume,
    schema,
    schemaReady,
    queue,
    scores,
    leases,
    ingestion,
    operations,
    schedulerV3FeatureFlag: process.env.INGESTION_SCHEDULER_V3_ENABLED || 'unset',
    violations,
    ready: violations.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.strict && violations.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
