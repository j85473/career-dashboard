import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { projectJobScoreAuthority } from '../src/lib/scoreAuthority';

const EXPECTED_DATABASE_PATH = '/career_dashboard_scoring_v2_verify';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const V1_MIGRATION = '20260812170000_manual_scoring_exchange_v1';
const V2_MIGRATION = '20260812230000_aim_factual_extraction_v2';

function verifiedUrl(): string {
  const raw = process.env.SCORING_V2_TEST_DATABASE_URL;
  if (!raw) throw new Error('SCORING_V2_TEST_DATABASE_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SCORING_V2_TEST_DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('migration verification requires PostgreSQL');
  }
  if (parsed.pathname !== EXPECTED_DATABASE_PATH) {
    throw new Error(`refusing database path ${parsed.pathname}; expected ${EXPECTED_DATABASE_PATH}`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`refusing nonlocal verification host ${parsed.hostname}`);
  }
  if (/(?:pi|prod|production)/iu.test(parsed.hostname)) {
    throw new Error('refusing Pi or production host');
  }
  return raw;
}

function childEnvironment(
  databaseUrl: string,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, ...extra, DATABASE_URL: databaseUrl };
  delete env.SCORING_V2_TEST_DATABASE_URL;
  return env as NodeJS.ProcessEnv;
}

function run(
  command: string,
  args: string[],
  databaseUrl: string,
  options: { input?: string; extraEnv?: Record<string, string | undefined> } = {},
): void {
  const completed = spawnSync(command, args, {
    cwd: process.cwd(),
    env: childEnvironment(databaseUrl, options.extraEnv),
    input: options.input,
    encoding: 'utf8',
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    timeout: 180_000,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${completed.status}`);
}

function runPrisma(args: string[], databaseUrl: string, input?: string): void {
  run('npx', ['prisma', ...args], databaseUrl, { input });
}

function resetSchema(databaseUrl: string): void {
  runPrisma(
    ['db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'],
    databaseUrl,
    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO CURRENT_USER;',
  );
}

function temporaryMigrationTree(): { root: string; schema: string; migrations: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-dashboard-scoring-v2-verify-'));
  const prismaRoot = path.join(root, 'prisma');
  const migrations = path.join(prismaRoot, 'migrations');
  mkdirSync(migrations, { recursive: true });
  cpSync('prisma/schema.prisma', path.join(prismaRoot, 'schema.prisma'));
  cpSync('prisma/migrations/migration_lock.toml', path.join(migrations, 'migration_lock.toml'));
  return { root, schema: path.join(prismaRoot, 'schema.prisma'), migrations };
}

function copyMigrationsThrough(destination: string, inclusiveName: string): void {
  const names = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(inclusiveName)) throw new Error(`migration ${inclusiveName} is missing`);
  for (const name of names) {
    if (name > inclusiveName) break;
    const target = path.join(destination, name);
    if (!existsSync(target)) cpSync(path.join('prisma/migrations', name), target, { recursive: true });
  }
}

function client(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function seedHistoricalV1(databaseUrl: string): Promise<void> {
  const db = client(databaseUrl);
  try {
    await db.$executeRawUnsafe(`
      INSERT INTO "Job" ("id", "title", "company", "description", "location", "source", "sourceId", "postedAt", "status", "updatedAt")
      VALUES ('v1-job', 'Channel Manager', 'Historical Example', 'Historical complete source.', 'Minneapolis, MN', 'verify', 'v1-job',
        '2026-08-12T10:00:00.000Z', 'inbox', '2026-08-12T11:00:00.000Z')
    `);
    for (const [batchId, stage, exportHash, manifestHash] of [
      ['v1-aim-batch', 'aim', 'a'.repeat(64), 'b'.repeat(64)],
      ['v1-experience-batch', 'experience', 'c'.repeat(64), 'd'.repeat(64)],
    ]) {
      await db.$executeRawUnsafe(`
        INSERT INTO "ScoringBatch" (
          "id", "stage", "status", "schemaVersion", "protocolVersion", "policyVersion",
          "exportHash", "manifestHash", "inputVersionsHash", "manifestSnapshot", "exportJson",
          "exportByteLength", "createdAt", "expiresAt", "completedAt"
        ) VALUES (
          '${batchId}', '${stage}', 'completed', 'career-dashboard-${stage}-export-v1',
          'career-dashboard-scoring-protocol-v1', '${stage}-policy-v1', '${exportHash}', '${manifestHash}',
          '${stage === 'aim' ? 'e' : 'f'}${'0'.repeat(63)}', '[]'::jsonb, '{}', 2,
          '2026-08-12T11:00:00.000Z', '2026-08-13T11:00:00.000Z', '2026-08-12T12:00:00.000Z'
        )
      `);
    }
    await db.$executeRawUnsafe(`
      INSERT INTO "ScoringBatchItem" (
        "id", "batchId", "jobId", "stage", "ordinal", "status", "submittedUpdatedAt",
        "sourceJdHash", "inputHash", "inputSnapshot", "importedAt"
      ) VALUES
        ('v1-aim-item', 'v1-aim-batch', 'v1-job', 'aim', 0, 'imported', '2026-08-12T11:00:00.000Z',
          '${'1'.repeat(64)}', '${'2'.repeat(64)}', '{"kind":"historical-aim"}'::jsonb, '2026-08-12T12:00:00.000Z'),
        ('v1-experience-item', 'v1-experience-batch', 'v1-job', 'experience', 0, 'imported', '2026-08-12T11:00:00.000Z',
          '${'1'.repeat(64)}', '${'3'.repeat(64)}', '{"kind":"historical-experience"}'::jsonb, '2026-08-12T12:00:00.000Z')
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "JobScoringArtifact" (
        "id", "jobId", "kind", "schemaVersion", "cleanerVersion", "sourceJdHash", "contentHash",
        "cleanedText", "removedSpans", "coverageAudit", "repairHistory", "producedByBatchItemId", "createdAt"
      ) VALUES (
        'v1-artifact', 'v1-job', 'cleaned_jd', 'career-dashboard-cleaned-jd-v1', 'jd-cleaner-v2',
        '${'1'.repeat(64)}', '${'4'.repeat(64)}', 'Historical complete source.', '[]'::jsonb,
        '{"complete":true,"findings":[]}'::jsonb, '[]'::jsonb, 'v1-aim-item', '2026-08-12T12:00:00.000Z'
      )
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "JobScoreEvent" (
        "id", "jobId", "evaluationType", "model", "promptVersion", "policyVersion", "schemaVersion",
        "batchId", "batchItemId", "manifestHash", "resultHash", "cleanedJdArtifactId", "decisionCode",
        "inputBindings", "workerProvenance", "lifecycleProjection", "aimFitScore", "passed", "createdAt"
      ) VALUES (
        'v1-aim-event', 'v1-job', 'aim_fit', 'historical-model', 'aim-workers-v1', 'aim-policy-v1',
        'career-dashboard-aim-result-v1', 'v1-aim-batch', 'v1-aim-item', '${'b'.repeat(64)}', '${'5'.repeat(64)}',
        'v1-artifact', 'survivor', '{"globalInputVersionsHash":"historical"}'::jsonb, '{}'::jsonb,
        'pending_af', 88, TRUE, '2026-08-12T12:00:00.000Z'
      )
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "JobScoreEvent" (
        "id", "jobId", "evaluationType", "model", "promptVersion", "policyVersion", "schemaVersion",
        "batchId", "batchItemId", "manifestHash", "resultHash", "sourceAimEventId", "cleanedJdArtifactId",
        "decisionCode", "inputBindings", "workerProvenance", "lifecycleProjection", "experienceFitScore", "passed", "createdAt"
      ) VALUES (
        'v1-experience-event', 'v1-job', 'experience_fit', 'historical-model', 'experience-workers-v1',
        'experience-policy-v1', 'career-dashboard-experience-result-v1', 'v1-experience-batch', 'v1-experience-item',
        '${'d'.repeat(64)}', '${'6'.repeat(64)}', 'v1-aim-event', 'v1-artifact', 'qualified',
        '{"globalInputVersionsHash":"historical"}'::jsonb, '{}'::jsonb, 'inbox', 92, TRUE,
        '2026-08-12T12:01:00.000Z'
      )
    `);
    await db.$executeRawUnsafe(`UPDATE "ScoringBatchItem" SET "cleanedArtifactId" = 'v1-artifact', "importedScoreEventId" = 'v1-aim-event' WHERE id = 'v1-aim-item'`);
    await db.$executeRawUnsafe(`UPDATE "ScoringBatchItem" SET "sourceAimEventId" = 'v1-aim-event', "cleanedArtifactId" = 'v1-artifact', "importedScoreEventId" = 'v1-experience-event' WHERE id = 'v1-experience-item'`);
  } finally {
    await db.$disconnect();
  }
}

async function historicalSnapshot(databaseUrl: string): Promise<{ rowsHash: string; authorityHash: string }> {
  const db = client(databaseUrl);
  try {
    const [snapshot] = await db.$queryRawUnsafe<Array<{ value: unknown }>>(`
      SELECT jsonb_build_object(
        'job', (SELECT to_jsonb(x) FROM (SELECT id, title, company, description, location, status, "updatedAt" FROM "Job" WHERE id = 'v1-job') x),
        'batches', (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id, stage, status, "schemaVersion", "protocolVersion", "policyVersion", "exportHash", "manifestHash", "acceptedResultHash", "completedAt" FROM "ScoringBatch" WHERE id LIKE 'v1-%') x),
        'items', (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id, "batchId", "jobId", stage, ordinal, status, "sourceJdHash", "inputHash", "sourceAimEventId", "cleanedArtifactId", "importedScoreEventId", "importedAt" FROM "ScoringBatchItem" WHERE id LIKE 'v1-%') x),
        'artifact', (SELECT to_jsonb(x) FROM (SELECT id, "jobId", kind, "schemaVersion", "cleanerVersion", "sourceJdHash", "contentHash", "cleanedText", "producedByBatchItemId", "staleAt" FROM "JobScoringArtifact" WHERE id = 'v1-artifact') x),
        'events', (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id, "jobId", "evaluationType", model, "promptVersion", "policyVersion", "schemaVersion", "batchId", "batchItemId", "sourceAimEventId", "cleanedJdArtifactId", "decisionCode", "aimFitScore", "experienceFitScore", passed, "staleAt" FROM "JobScoreEvent" WHERE id LIKE 'v1-%') x)
      ) AS value
    `);
    const job = { status: 'inbox', passReason: null, compensation: null };
    const authority = projectJobScoreAuthority(job, {
      legacy: null,
      aim: {
        id: 'v1-aim-event', evaluationType: 'aim_fit', schemaVersion: 'career-dashboard-aim-result-v1',
        staleAt: null, inputBindingsCurrent: true, passed: true, aimFitScore: 88,
        cleanedJdArtifactId: 'v1-artifact', aimReason: 'historical Aim',
      },
      experience: {
        id: 'v1-experience-event', evaluationType: 'experience_fit', schemaVersion: 'career-dashboard-experience-result-v1',
        staleAt: null, inputBindingsCurrent: true, sourceAimEventId: 'v1-aim-event',
        cleanedJdArtifactId: 'v1-artifact', experienceFitScore: 92, experienceReason: 'historical Experience',
      },
      cleanedArtifact: { id: 'v1-artifact', contentHash: '4'.repeat(64), staleAt: null },
      aimExtraction: null,
    });
    return { rowsHash: canonicalJsonSha256(snapshot.value), authorityHash: canonicalJsonSha256(authority) };
  } finally {
    await db.$disconnect();
  }
}

async function assertV2UpgradeIsAdditive(databaseUrl: string): Promise<void> {
  const db = client(databaseUrl);
  try {
    const [counts] = await db.$queryRawUnsafe<Array<Record<string, bigint>>>(`
      SELECT
        (SELECT COUNT(*) FROM "AimFactualExtraction")::bigint AS extractions,
        (SELECT COUNT(*) FROM "AimScoringFailureReceipt")::bigint AS failures,
        (SELECT COUNT(*) FROM "ScoringBatch" WHERE id LIKE 'v1-%' AND "questionRegistryHash" IS NULL AND "scoringPolicyHash" IS NULL)::bigint AS batches,
        (SELECT COUNT(*) FROM "ScoringBatchItem" WHERE id LIKE 'v1-%' AND "aimFactualExtractionId" IS NULL AND "manualRetryOfFailureReceiptId" IS NULL)::bigint AS items,
        (SELECT COUNT(*) FROM "JobScoreEvent" WHERE id LIKE 'v1-%' AND "aimFactualExtractionId" IS NULL AND "scoringIdentity" IS NULL AND "semanticResultHash" IS NULL)::bigint AS events
    `);
    assert.equal(Number(counts.extractions), 0);
    assert.equal(Number(counts.failures), 0);
    assert.equal(Number(counts.batches), 2);
    assert.equal(Number(counts.items), 2);
    assert.equal(Number(counts.events), 2);
  } finally {
    await db.$disconnect();
  }
}

function runIntegrationSuite(databaseUrl: string): void {
  run(process.execPath, ['--import', 'tsx', '--test', 'tests/integration/scoringImportV2.postgres.test.ts'], databaseUrl, {
    extraEnv: { SCORING_V2_MIGRATION_VERIFY_ACTIVE: '1' },
  });
}

async function main(): Promise<void> {
  const databaseUrl = verifiedUrl();
  console.log(JSON.stringify({ phase: 'guarded-verification-start', database: EXPECTED_DATABASE_PATH, host: new URL(databaseUrl).hostname }));

  runPrisma(['migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], databaseUrl);
  runPrisma(['migrate', 'status', '--schema', 'prisma/schema.prisma'], databaseUrl);
  runIntegrationSuite(databaseUrl);

  resetSchema(databaseUrl);
  const temporary = temporaryMigrationTree();
  try {
    copyMigrationsThrough(temporary.migrations, V1_MIGRATION);
    runPrisma(['migrate', 'deploy', '--schema', temporary.schema], databaseUrl);
    await seedHistoricalV1(databaseUrl);
    const before = await historicalSnapshot(databaseUrl);

    copyMigrationsThrough(temporary.migrations, V2_MIGRATION);
    runPrisma(['migrate', 'deploy', '--schema', temporary.schema], databaseUrl);
    runPrisma(['migrate', 'status', '--schema', temporary.schema], databaseUrl);
    const after = await historicalSnapshot(databaseUrl);
    assert.deepEqual(after, before, 'v2 migration changed historical v1 rows or authority projection');
    await assertV2UpgradeIsAdditive(databaseUrl);
    runIntegrationSuite(databaseUrl);
  } finally {
    rmSync(temporary.root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: 'pass', freshMigration: true, historicalUpgrade: true, postgresIntegration: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
