import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { assertPrismaRehearsalUrl } from '../../src/lib/prismaRehearsal';

// Start the built app with the rehearsal wrapper on 127.0.0.1:3107 first.
if (process.env.PRISMA7_REHEARSAL !== '1') throw new Error('Use scripts/prisma7-rehearsal.mjs.');
assertPrismaRehearsalUrl(process.env.DATABASE_URL!, process.env.DATABASE_RUNTIME_HOST);

async function main() {
  const origin = 'http://127.0.0.1:3107';
  const started = Date.now();
  const cold = await fetch(`${origin}/api/stats`, { signal: AbortSignal.timeout(90_000) });
  assert.equal(cold.status, 200, 'the complete cold Stats snapshot must load on the production copy');
  assert.equal(cold.headers.get('x-career-stats-cache'), 'miss', 'restart the private app before this test');
  const coldBody = await cold.json();
  const coldMs = Date.now() - started;
  assert.ok(coldBody.totalJobs > 3_000_000, 'exercise the complete copied history');
  const warmStarted = Date.now();
  const warm = await fetch(`${origin}/api/stats`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(warm.status, 200);
  assert.equal(warm.headers.get('x-career-stats-cache'), 'hit');
  assert.deepEqual(await warm.json(), coldBody, 'the warm response must reuse the completed snapshot');
  const report = { checkedAt: new Date().toISOString(), coldMs, warmMs: Date.now() - warmStarted,
    jobs: coldBody.totalJobs, coldCache: 'miss', warmCache: 'hit' };
  if (process.env.PRISMA7_STATS_REPORT) writeFileSync(process.env.PRISMA7_STATS_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
