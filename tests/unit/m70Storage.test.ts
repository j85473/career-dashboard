import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('storage retention preserves running work and reserves the next nightly backup during new allocations', () => {
  const result = spawnSync('python3', ['tests/maintenance/test_m70_storage.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('deployment and daily cleanup use the same release lock and capacity budget', () => {
  const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
  const backup = readFileSync('scripts/deployment/m70-backup.sh', 'utf8');
  assert.ok(activation.indexOf('flock -w 2700 8') < activation.indexOf('npm ci'));
  assert.ok(activation.indexOf('check-capacity --extra-bytes') < activation.indexOf('npm ci'));
  assert.ok(activation.indexOf('check-capacity --extra-backup') < activation.lastIndexOf('systemctl stop career-dashboard.service'));
  assert.match(activation, /cleanup --apply --deploy-lock-held --protect-release "\$OLD"/);
  assert.ok(backup.indexOf('flock -n 9') < backup.indexOf('m70-storage.py cleanup --apply'));
  assert.ok(backup.indexOf('m70-storage.py cleanup --apply') < backup.indexOf('backup-postgres.mjs'));
});
