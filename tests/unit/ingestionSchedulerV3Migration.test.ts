import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const verifier = path.resolve('scripts/verify_ingestion_scheduler_v3.ts');

test('scheduler v3 database verifier refuses to fall back to production DATABASE_URL', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', verifier], {
    cwd: process.cwd(),
    env: { ...process.env, INGESTION_SCHEDULER_V3_TEST_DATABASE_URL: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /production DATABASE_URL is never accepted/);
});

test('scheduler v3 verifier requires local, unmistakably named disposable database', () => {
  const source = readFileSync(verifier, 'utf8');
  assert.match(source, /\['localhost', '127\.0\.0\.1', '::1'\]/);
  assert.match(source, /_ingestion_scheduler_v3_test/);
  assert.match(source, /dedicated verifier database must start empty/);
  assert.match(source, /leasedRowsPreserved/);
  assert.match(source, /concurrentReservationsAllowed/);
});
