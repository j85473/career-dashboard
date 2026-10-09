import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('M70 maintenance defers unsafe reboots and recovers prior service ownership', () => {
  const result = spawnSync('python3', ['tests/maintenance/test_m70_maintenance.py'], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
});
