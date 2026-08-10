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
const CANONICAL_SHA256 = '23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059';
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
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'JobScoreEvent' AND column_name = 'staleAt'
      ) AS "scoreStaleness";
  `;
  const schema = {
    ingestionTask: schemaRow?.ingestionTask === true,
    providerCircuit: schemaRow?.providerCircuit === true,
    providerIncident: schemaRow?.providerIncident === true,
    jobPipelineEvent: schemaRow?.jobPipelineEvent === true,
    contextRule: schemaRow?.contextRule === true,
    scoreStaleness: schemaRow?.scoreStaleness === true,
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

  const [nativeRequestRows, scoringLeaseRows, contextLeaseRows, pipelineLockRows] = await Promise.all([
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
  ]);
  const leases = {
    nativeRequests: Object.fromEntries(Object.entries(nativeRequestRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    scoringJobs: Object.fromEntries(Object.entries(scoringLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    contextProfiles: Object.fromEntries(Object.entries(contextLeaseRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
    pipeline: Object.fromEntries(Object.entries(pipelineLockRows[0] || {}).map(([key, value]) => [key, asNumber(value)])),
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
    const [taskRow, runRow, atsRow, seededTaskRows] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*)::bigint AS "taskCount",
          COUNT(*) FILTER (WHERE "nextRunAt" <= NOW())::bigint AS overdue,
          COUNT(*) FILTER (
            WHERE "leaseExpiresAt" < NOW() AND "leaseToken" IS NOT NULL
          )::bigint AS "staleLeases",
          COUNT(*) FILTER (
            WHERE "leaseToken" IS NOT NULL
          )::bigint AS "activeLeases",
          COUNT(*) FILTER (
            WHERE status = 'running'
          )::bigint AS "runningTasks",
          COUNT(*) FILTER (
            WHERE "seenCount" <> "insertedCount" + "duplicateCount" + "filteredCount" + "processingErrorCount"
          )::bigint AS "counterMismatches"
        FROM "IngestionTask";
      `,
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
