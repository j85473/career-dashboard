import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runWith(value?: string) {
  const env = { ...process.env };
  delete env.SCORING_V2_TEST_DATABASE_URL;
  if (value !== undefined) env.SCORING_V2_TEST_DATABASE_URL = value;
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify_scoring_v2_migration.ts'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000,
  });
}

test('migration verifier refuses missing, remote, and wrong-name databases before Prisma execution', () => {
  const missing = runWith();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SCORING_V2_TEST_DATABASE_URL is required/);

  const remote = runWith('postgresql://example.com:5432/career_dashboard_scoring_v2_verify');
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /refusing nonlocal verification host/);

  const wrongName = runWith('postgresql://localhost:5432/career_dashboard');
  assert.notEqual(wrongName.status, 0);
  assert.match(wrongName.stderr, /expected \/career_dashboard_scoring_v2_verify/);
  for (const result of [missing, remote, wrongName]) {
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /prisma migrate|Applying migration|TRUNCATE TABLE/);
  }
});
