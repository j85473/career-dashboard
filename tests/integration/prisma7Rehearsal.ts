import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '../../src/lib/prismaClient';
import { assertPrismaRehearsalUrl } from '../../src/lib/prismaRehearsal';
import { buildControlDatabaseUrl } from '../../src/lib/controlDatabaseUrl';
import { isPrismaConnectionFailure } from '../../src/lib/prismaTransactionErrors';

if (process.env.PRISMA7_REHEARSAL !== '1') throw new Error('Use scripts/prisma7-rehearsal.mjs.');
assertPrismaRehearsalUrl(process.env.DATABASE_URL!, process.env.DATABASE_RUNTIME_HOST);
const prisma = new PrismaClient();
const control = new PrismaClient({ datasourceUrl: buildControlDatabaseUrl(process.env.DATABASE_URL!) });
const slug = `prisma7-rehearsal-${randomUUID()}`;
const board = { slug, platform: 'Prisma7-Rehearsal' };
const where = { slug_platform: board };

async function preservationFingerprint() {
  // Hash every saved column, including the immutable score/application history.
  // Order-independent SHA-256 lane aggregates avoid random UUID heap reads.
  const tables = ['Job', 'JobScoreEvent', 'JobStatusHistory'] as const;
  type Fingerprint = { jobs: string; xor: string[]; sums: string[] };
  const fingerprints = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather = 3');
    await tx.$executeRawUnsafe('SET LOCAL parallel_setup_cost = 0');
    await tx.$executeRawUnsafe('SET LOCAL parallel_tuple_cost = 0');
    const results = {} as Record<typeof tables[number], Fingerprint>;
    for (const table of tables) {
      const [result] = await tx.$queryRaw<Fingerprint[]>`
    WITH hashes AS MATERIALIZED (
      SELECT sha256(convert_to(row_to_json(j)::text,'UTF8')) AS digest
      FROM ${Prisma.raw(`"${table}"`)} j
    )
    SELECT count(*)::text AS jobs,
      ARRAY[coalesce(bit_xor(a),0)::text, coalesce(bit_xor(b),0)::text,
        coalesce(bit_xor(c),0)::text, coalesce(bit_xor(d),0)::text] AS xor,
      ARRAY[coalesce(sum(a::numeric),0)::text, coalesce(sum(b::numeric),0)::text,
        coalesce(sum(c::numeric),0)::text, coalesce(sum(d::numeric),0)::text] AS sums
    FROM hashes
    CROSS JOIN LATERAL (SELECT
      ('x'||encode(substring(digest FROM 1 FOR 8),'hex'))::bit(64)::bigint AS a,
      ('x'||encode(substring(digest FROM 9 FOR 8),'hex'))::bit(64)::bigint AS b,
      ('x'||encode(substring(digest FROM 17 FOR 8),'hex'))::bit(64)::bigint AS c,
      ('x'||encode(substring(digest FROM 25 FOR 8),'hex'))::bit(64)::bigint AS d
      OFFSET 0) lanes
    `;
      results[table] = result;
    }
    return results;
  }, { timeout: 20 * 60_000, maxWait: 10_000 });
  const digest = (value: Fingerprint) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const [scores, migrations, extensions] = await Promise.all([
    prisma.$queryRaw<Array<{ aim: bigint; experience: bigint; legacy: bigint }>>`
      SELECT count("aimFitScore") AS aim, count("reqFitScore") AS experience, count("fitScore") AS legacy FROM "Job"
    `,
    prisma.$queryRaw<Array<{ name: string }>>`SELECT migration_name AS name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
    prisma.$queryRaw<Array<{ name: string }>>`SELECT extname AS name FROM pg_extension ORDER BY extname`,
  ]);
  return {
    jobs: Number(fingerprints.Job.jobs), jobDigest: digest(fingerprints.Job),
    scores: scores.map(row => ({ aim: String(row.aim), experience: String(row.experience), legacy: String(row.legacy) })),
    scoreEvents: Number(fingerprints.JobScoreEvent.jobs), scoreEventsDigest: digest(fingerprints.JobScoreEvent),
    applicationHistory: Number(fingerprints.JobStatusHistory.jobs), applicationHistoryDigest: digest(fingerprints.JobStatusHistory),
    migrations: migrations.map(row => row.name), extensions: extensions.map(row => row.name),
  };
}

async function main() {
  const identity = await prisma.$queryRaw<Array<{ database: string; port: number; role: string; superuser: boolean }>>`
    SELECT current_database() AS database, inet_server_port() AS port,
      current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user
  `;
  assert.deepEqual(identity, [{ database: 'career_prisma7', port: 55433, role: 'career_prisma7', superuser: false }]);
  console.log(JSON.stringify({ phase: 'fingerprint-before', database: identity[0] }));
  const before = await preservationFingerprint();
  console.log(JSON.stringify({ phase: 'baseline', ...before }));
  await prisma.atsCompany.create({ data: { ...board, checkDay: 0 } });
  try {
    await assert.rejects(prisma.atsCompany.create({ data: { ...board, checkDay: 0 } }), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    await Promise.all(Array.from({ length: 20 }, () => prisma.atsCompany.update({ where, data: { failCount: { increment: 1 } } })));
    assert.equal((await prisma.atsCompany.findUniqueOrThrow({ where })).failCount, 20);
    const fence = BigInt('9007199254740993');
    const timestamp = new Date('2026-10-15T12:34:56.789Z');
    const payload = { nested: ['preserved', 0, false, null], metadata: { source: 'rehearsal' } };
    const batch = await prisma.atsIngestionBatch.create({ data: {
      ...board, acquisitionClaimFence: fence, payload, respondedAt: timestamp,
    } });
    await Promise.all(Array.from({ length: 10 }, () => prisma.atsIngestionBatch.update({
      where: { id: batch.id }, data: { acquisitionClaimFence: { increment: BigInt(1) } },
    })));
    const saved = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } });
    assert.equal(saved.acquisitionClaimFence, fence + BigInt(10));
    assert.equal(saved.respondedAt?.toISOString(), timestamp.toISOString());
    assert.deepEqual(saved.payload, payload);
    const rollback = new Error('rehearsal rollback');
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.atsCompany.update({ where, data: { failCount: { increment: 100 } } });
      throw rollback;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), error => error === rollback);
    assert.equal((await prisma.atsCompany.findUniqueOrThrow({ where })).failCount, 20);

    // A serializable conflict must still produce the retriable P2034 contract.
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const contenders = await Promise.allSettled([1, 2].map(() => prisma.$transaction(async tx => {
      const row = await tx.atsCompany.findUniqueOrThrow({ where });
      if (++arrivals === 2) release();
      await gate;
      return tx.atsCompany.update({ where, data: { failCount: row.failCount + 1 } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 })));
    assert.equal(contenders.filter(row => row.status === 'fulfilled').length, 1);
    const conflict = contenders.find(row => row.status === 'rejected') as PromiseRejectedResult;
    assert.equal(conflict.reason.code, 'P2034');

    // Exhaust a one-connection data pool and prove the independent control
    // client can still answer while the data transaction is held open.
    const oneUrl = new URL(process.env.DATABASE_URL!);
    oneUrl.searchParams.set('connection_limit', '1');
    oneUrl.searchParams.set('pool_timeout', '1');
    const one = new PrismaClient({ datasourceUrl: oneUrl.toString() });
    let unlock!: () => void;
    let ready!: () => void;
    const readyGate = new Promise<void>(resolve => { ready = resolve; });
    const heldGate = new Promise<void>(resolve => { unlock = resolve; });
    const held = one.$transaction(async tx => { await tx.$queryRaw`SELECT 1`; ready(); await heldGate; }, { timeout: 10_000 });
    try {
      await readyGate;
      assert.equal((await control.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`)[0].ok, 1);
      const started = Date.now();
      await assert.rejects(one.$queryRaw`SELECT 1`, isPrismaConnectionFailure);
      assert.ok(Date.now() - started < 5_000, 'pool saturation must stay bounded');
    } finally {
      unlock(); await held; await one.$disconnect();
    }
  } finally {
    await prisma.atsIngestionBatch.deleteMany({ where: board });
    await prisma.atsCompany.delete({ where });
  }
  console.log(JSON.stringify({ phase: 'fixtures-passed; fingerprint-after' }));
  const after = await preservationFingerprint();
  assert.deepEqual(after, before, 'every saved job, score event, and application-history column must survive unchanged');
  const report = { checkedAt: new Date().toISOString(), database: identity[0], checks: ['P2002 duplicates', '20 concurrent atomic increments', 'BigInt fence increments above JavaScript integer precision', 'JSON and UTC millisecond timestamp round trips', 'Serializable rollback', 'P2034 serialization conflicts', 'separate control pool under data saturation', 'bounded queue timeout classified as database availability failure', 'all saved job columns and score/history counts unchanged'], before, after };
  const output = process.env.PRISMA7_REHEARSAL_REPORT;
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, ...report }));
}

main().catch(error => {
  console.error('Prisma 7 rehearsal failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all([prisma.$disconnect(), control.$disconnect()]);
});
