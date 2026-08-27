import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const audit = readFileSync('scripts/deployment/audit-storage.sh', 'utf8');
const deploy = readFileSync('scripts/deploy.sh', 'utf8');

test('storage audit is read-only and reports SSD transport boundaries', () => {
  assert.match(audit, /queue\/rotational/);
  assert.match(audit, /ID_USB_DRIVER/);
  assert.match(audit, /DISC-MAX/);
  assert.match(audit, /database mount uses relatime/);
  assert.doesNotMatch(audit, /^\s*(?:sudo\s+)?(?:mount|umount|fstrim|tee|sed\s+-i|systemctl\s+(?:enable|disable))\b/m);
});

test('every Pi deployment records the storage audit without mutating host configuration', () => {
  assert.match(deploy, /POSTGRES_DATA_DIRECTORY="\$\{POSTGRES_DATA_DIRECTORY:-\/mnt\/pgdata\/main\}"/);
  assert.match(deploy, /scripts\/deployment\/audit-storage\.sh/);
  assert.match(deploy, /record_phase "storage-audit"/);
});
