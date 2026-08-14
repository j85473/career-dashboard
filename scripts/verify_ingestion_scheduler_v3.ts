import 'dotenv/config';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

import type { IngestionTaskSpec } from '../src/lib/ingestionControl';

const TEST_DATABASE_VARIABLE = 'INGESTION_SCHEDULER_V3_TEST_DATABASE_URL';
const V3_MIGRATION = '20260814200000_ingestion_scheduler_v3_lifecycle';

function dedicatedDatabaseUrl(): string {
  const raw = process.env[TEST_DATABASE_VARIABLE];
  if (!raw) throw new Error(`${TEST_DATABASE_VARIABLE} is required; production DATABASE_URL is never accepted.`);
  const url = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`${TEST_DATABASE_VARIABLE} must use a local PostgreSQL host.`);
  }
  const database = url.pathname.replace(/^\//, '');
  if (!database.endsWith('_ingestion_scheduler_v3_test')) {
    throw new Error(`${TEST_DATABASE_VARIABLE} database name must end with _ingestion_scheduler_v3_test.`);
  }
  if (raw === process.env.DATABASE_URL) throw new Error('Dedicated test URL must not equal DATABASE_URL.');
  return raw;
}

function writeProductionShapedPrechangeSchema(targetRoot: string): string {
  const prismaRoot = path.join(targetRoot, 'prisma');
  mkdirSync(prismaRoot, { recursive: true });
  const schemaPath = path.join(prismaRoot, 'schema.prisma');
  const schema = readFileSync('prisma/schema.prisma', 'utf8').replace(
    /model IngestionTask \{[\s\S]*?\n\}/,
    (model) => model
      .replace(/^\s*taskKind\s+String\s+@default\("search"\)\s*$/m, '')
      .replace(/^\s*lifecycleStatus\s+String\s+@default\("active"\)\s*$/m, '')
      .replace(/^\s*retiredAt\s+DateTime\?\s*$/m, '')
      .replace(/^\s*@@index\(\[taskKind, lifecycleStatus, status, nextRunAt\]\)\s*$/m, ''),
  );
  writeFileSync(schemaPath, schema);
  return schemaPath;
}

function runPrisma(args: string[], databaseUrl: string): void {
  const prismaCli = path.resolve('node_modules/.bin/prisma');
  if (!existsSync(prismaCli)) throw new Error('Local Prisma CLI is missing.');
  execFileSync(prismaCli, args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

async function main(): Promise<void> {
  const databaseUrl = dedicatedDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;
  const probe = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const [row] = await probe.$queryRaw<Array<{ tableCount: bigint }>>`
      SELECT COUNT(*)::bigint AS "tableCount"
      FROM pg_tables WHERE schemaname = 'public';
    `;
    assert.equal(Number(row.tableCount), 0, 'dedicated verifier database must start empty');
  } finally {
    await probe.$disconnect();
  }
  const {
    buildIngestionTaskKey,
    reconcileIngestionTaskCatalog,
    recordProviderFailure,
    recordProviderSuccess,
    reserveProviderRequest,
  } = await import('../src/lib/ingestionControl');
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ingestion-scheduler-v3-'));
  const schemaPath = writeProductionShapedPrechangeSchema(temporary);
  runPrisma(['db', 'push', '--schema', schemaPath, '--skip-generate'], databaseUrl);

  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const [before] = await client.$queryRaw<Array<{ lifecycleColumns: bigint }>>`
      SELECT COUNT(*)::bigint AS "lifecycleColumns"
      FROM information_schema.columns
      WHERE table_name = 'IngestionTask'
        AND column_name IN ('taskKind', 'lifecycleStatus', 'retiredAt');
    `;
    assert.equal(Number(before.lifecycleColumns), 0, 'pre-change schema unexpectedly has lifecycle fields');

    runPrisma([
      'db', 'execute',
      '--file', path.join('prisma/migrations', V3_MIGRATION, 'migration.sql'),
      '--schema', schemaPath,
    ], databaseUrl);
    const [after] = await client.$queryRaw<Array<{ lifecycleColumns: bigint; lifecycleIndex: bigint }>>`
      SELECT
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'IngestionTask'
            AND column_name IN ('taskKind', 'lifecycleStatus', 'retiredAt'))::bigint AS "lifecycleColumns",
        (SELECT COUNT(*) FROM pg_indexes
          WHERE tablename = 'IngestionTask'
            AND indexname = 'IngestionTask_taskKind_lifecycleStatus_status_nextRunAt_idx')::bigint AS "lifecycleIndex";
    `;
    assert.equal(Number(after.lifecycleColumns), 3);
    assert.equal(Number(after.lifecycleIndex), 1);

    const spec: IngestionTaskSpec = {
      source: 'Verifier', queryFamily: 'sales', searchQuery: 'sales', geoLane: 'test', ingestionMode: 'test',
    };
    const expectedKey = buildIngestionTaskKey(spec);
    await client.ingestionTask.createMany({
      data: [
        { taskKey: expectedKey, source: 'Verifier', queryFamily: 'sales', searchQuery: 'sales', geoLane: 'test', ingestionMode: 'test', lifecycleStatus: 'retired' },
        { taskKey: 'verifier:retire', source: 'Retired', geoLane: 'test', ingestionMode: 'test' },
        { taskKey: 'verifier:leased', source: 'Leased', geoLane: 'test', ingestionMode: 'test', status: 'running', leaseToken: 'verifier-lease' },
        { taskKey: 'scheduler:v2:legacy-orchestration', source: 'scheduler', geoLane: 'global', ingestionMode: 'orchestration', nextRunAt: new Date(0) },
      ],
    });
    const preview = await reconcileIngestionTaskCatalog([spec], { client });
    assert.deepEqual(preview.leasedConflicts, ['verifier:leased']);
    await assert.rejects(() => reconcileIngestionTaskCatalog([spec], { apply: true, client }), /leased\/running/);
    const leasedBefore = await client.ingestionTask.findUniqueOrThrow({ where: { taskKey: 'verifier:leased' } });
    assert.equal(leasedBefore.lifecycleStatus, 'active', 'failed apply mutated leased row');
    await client.ingestionTask.update({ where: { taskKey: 'verifier:leased' }, data: { status: 'succeeded', leaseToken: null } });
    await reconcileIngestionTaskCatalog([spec], { apply: true, client });
    const secondPreview = await reconcileIngestionTaskCatalog([spec], { client });
    assert.equal(secondPreview.additions.length + secondPreview.reactivations.length + secondPreview.retirements.length + secondPreview.orchestration.length, 0);

    const provider = 'VerifierProvider';
    const reservations = await Promise.all(Array.from({ length: 20 }, () => reserveProviderRequest({ provider, dailyLimit: 7 })));
    assert.equal(reservations.filter((decision) => decision.allowed).length, 7);
    const circuit = await client.providerCircuit.findUniqueOrThrow({ where: { provider } });
    assert.equal(circuit.dailyUsed, 7);
    const newerFailure = new Date('2026-08-14T18:01:00.000Z');
    await recordProviderFailure({ provider, error: new Error('HTTP 429'), now: newerFailure });
    await recordProviderSuccess(provider, new Date('2026-08-14T18:00:00.000Z'));
    await Promise.all([
      recordProviderFailure({ provider, error: new Error('HTTP 429 concurrent-a'), now: new Date('2026-08-14T18:03:00.000Z') }),
      recordProviderSuccess(provider, new Date('2026-08-14T18:02:00.000Z')),
      recordProviderFailure({ provider, error: new Error('HTTP 429 concurrent-b'), now: new Date('2026-08-14T18:04:00.000Z') }),
      recordProviderSuccess(provider, new Date('2026-08-14T18:01:30.000Z')),
    ]);
    const orderedCircuit = await client.providerCircuit.findUniqueOrThrow({ where: { provider } });
    assert.equal(orderedCircuit.state, 'open', 'older success closed newer failure');
    assert.equal(orderedCircuit.lastFailureAt?.toISOString(), '2026-08-14T18:04:00.000Z');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      database: new URL(databaseUrl).pathname.slice(1),
      migration: V3_MIGRATION,
      baseline: 'production-shaped-prechange-schema',
      catalogHash: preview.catalogHash,
      catalogIdempotent: true,
      leasedRowsPreserved: true,
      concurrentReservationsAllowed: 7,
      concurrentProviderMutationsOrdered: true,
      olderSuccessRejected: true,
    }, null, 2)}\n`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
