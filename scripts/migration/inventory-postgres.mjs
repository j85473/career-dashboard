#!/usr/bin/env node
// Preparation only: every database query runs inside a READ ONLY transaction.
// Launch through scripts/with-env.mjs; never print the connection URL or raw errors.
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/with-env.mjs node scripts/migration/inventory-postgres.mjs [--include-row-counts]');
  console.log('Prints database metadata and job-state counts. The optional flag counts every user table; use during a restore rehearsal or after writers are stopped. No database writes.');
  process.exit(0);
}
if (args.some(arg => arg !== '--include-row-counts')) {
  console.error('Unknown argument; use --help.');
  process.exit(2);
}

let url;
try {
  url = new URL(process.env.DATABASE_URL);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error();
  if (process.env.DATABASE_RUNTIME_HOST) {
    if (!/^[a-zA-Z0-9.:-]+$/.test(process.env.DATABASE_RUNTIME_HOST)) throw new Error();
    url.hostname = process.env.DATABASE_RUNTIME_HOST;
  }
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '5');
} catch {
  console.error('A valid PostgreSQL DATABASE_URL and optional hostname-only DATABASE_RUNTIME_HOST are required.');
  process.exit(2);
}

const prisma = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
try {
  const report = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$queryRawUnsafe("SELECT set_config('statement_timeout', '15000', true), set_config('lock_timeout', '2000', true)");
    const read = sql => tx.$queryRawUnsafe(sql);
    const database = await read(`SELECT current_database() AS name,
      current_setting('server_version') AS version,
      current_setting('transaction_read_only') AS transaction_read_only,
      pg_database_size(oid)::text AS bytes,
      pg_encoding_to_char(encoding) AS encoding, datlocprovider::text AS locale_provider,
      datcollate, datctype, datcollversion,
      pg_database_collation_actual_version(oid) AS actual_collation_version
      FROM pg_database WHERE datname = current_database()`);
    const extensions = await read('SELECT extname, extversion FROM pg_extension ORDER BY extname');
    const schemas = await read(`SELECT nspname AS name FROM pg_namespace
      WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY nspname`);
    const tables = await read(`SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
      c.relpersistence::text AS persistence, c.relrowsecurity AS row_security,
      pg_total_relation_size(c.oid)::text AS bytes,
      EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p') AS has_primary_key
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`);
    const schemaCounts = await read(`SELECT
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public') AS indexes,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS user_triggers,
      (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname='public' AND c.contype='x') AS exclusion_constraints,
      (SELECT count(*)::int FROM information_schema.sequences WHERE sequence_schema='public') AS sequences,
      (SELECT count(*)::int FROM pg_largeobject_metadata) AS large_objects`);
    const triggerInventory = await read(`SELECT c.relname AS table_name, t.tgname AS name,
      t.tgenabled::text AS enabled, md5(pg_get_triggerdef(t.oid)) AS definition_md5
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
    const invalidIndexes = await read(`SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready) ORDER BY c.relname`);
    const jobs = await read(`SELECT count(*)::text AS total,
      count("aimFitScore")::text AS aim_scored, count("reqFitScore")::text AS experience_scored,
      count("fitScore")::text AS legacy_fit_scored FROM "Job"`);
    const jobStatuses = await read('SELECT status, count(*)::text AS count FROM "Job" GROUP BY status ORDER BY status');
    const migrations = await read(`SELECT migration_name, checksum,
      finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
      FROM "_prisma_migrations" ORDER BY migration_name,id`);
    const acquisitionGate = await read(`SELECT "admissionState", "remoteWorkersEnabled", "globalSlotLimit",
      "localSlotReserve", "publicationPaused", "minimumWriterVersion", "distributedWriterVersion"
      FROM "AtsAcquisitionRuntimeGate" ORDER BY id`);
    const acquisitionSlots = await read(`SELECT "workerKind", "releaseId",
      count(*)::int AS slots, count(*) FILTER (WHERE "leaseExpiresAt">now())::int AS unexpired_leases
      FROM "AtsAcquisitionWorkerSlot" GROUP BY "workerKind","releaseId" ORDER BY "workerKind","releaseId"`);
    const connections = await read(`SELECT client_addr::text AS client_address, state, count(*)::int AS count
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      GROUP BY client_addr,state ORDER BY client_addr,state`);
    const rowCounts = {};
    if (args.includes('--include-row-counts')) {
      for (const table of tables) {
        const quote = name => '"' + name.replaceAll('"', '""') + '"';
        const [row] = await read(`SELECT count(*)::text AS count FROM ${quote(table.schema)}.${quote(table.name)}`);
        rowCounts[`${table.schema}.${table.name}`] = row.count;
      }
    }
    return { capturedAt: new Date().toISOString(), purpose: 'Read-only preparation snapshot; not proof of a frozen source or a successful restore',
      database, extensions, schemas, tables, publicSchemaCounts: schemaCounts, triggerInventory, invalidIndexes,
      jobs, jobStatuses, migrations, acquisitionGate, acquisitionSlots, connections,
      allUserTablesCounted: args.includes('--include-row-counts'), rowCounts };
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 120000 });
  console.log(JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
} catch (error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9]{4,8}$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`Read-only inventory failed${code}. No complete report was produced. Check connectivity, PostgreSQL permissions, schema compatibility, and query timeouts without publishing credentials.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
