import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('v2 reachability audit proves cleaner, native, and v1 Aim paths are unreachable', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/audit_scoring_v2_reachability.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /"status": "pass"/);
  assert.match(run.stdout, /"retiredRoutes": 9/);
});
