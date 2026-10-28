import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('paired repository recovery points preserve data through failures and retention', () => {
  const result = spawnSync('python3', ['tests/maintenance/test_m70_repository_backup.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('repository backups remain scheduled and verifiable across application rollback', () => {
  const install = readFileSync('scripts/deployment/install-m70-repository-backup.sh', 'utf8');
  const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
  const maintenance = readFileSync('scripts/deployment/m70-auto-maintenance.py', 'utf8');
  assert.match(install, /backup-repository-enabled/);
  assert.match(install, /60-repository-backup\.conf/);
  assert.match(install, /StartLimitIntervalSec=8h/);
  assert.match(install, /TimeoutStartSec=3h/);
  assert.match(install, /ExecStart=\nExecStart=\/usr\/local\/sbin\/career-m70-repository-backup/);
  assert.match(install, /\/usr\/local\/lib\/career-dashboard\/m70-repository-backup\.py/);
  assert.match(activation, /install-m70-repository-backup\.sh/);
  assert.match(maintenance, /'verify-latest'\], timeout=3600/);
});
