import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function drain(states: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'unit-drain-'));
  try {
    writeFileSync(path.join(root, 'states'), states.join('\n') + '\n');
    writeFileSync(path.join(root, 'cursor'), '1');
    writeFileSync(path.join(root, 'systemctl'), `#!/bin/bash
set -eu
test "$1" = show
test "$2" = fixture.service
line=$(cat "$DRAIN_FIXTURE/cursor")
state=$(sed -n "\${line}p" "$DRAIN_FIXTURE/states")
printf '%s' "$((line + 1))" > "$DRAIN_FIXTURE/cursor"
test "$state" != query-error || exit 1
printf '%s\\n' "$state"
`, { mode: 0o755 });
    writeFileSync(path.join(root, 'sleep'), '#!/bin/bash\nprintf "wait\\n" >> "$DRAIN_FIXTURE/waits"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/deployment/wait-unit-idle.sh', 'fixture.service'], {
      env: { ...process.env, DRAIN_FIXTURE: root, PATH: `${root}:${process.env.PATH}` }, encoding: 'utf8', timeout: 15_000,
    });
    return { ...result, reads: Number(readFileSync(path.join(root, 'cursor'), 'utf8')) - 1 };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a running one-shot crawler must finish before release quiescence is checked', () => {
  const result = drain(['activating', 'activating', 'active', 'reloading', 'deactivating', 'inactive']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.reads, 6);
  const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
  const wait = activation.indexOf('bash "$STAGE/scripts/deployment/wait-unit-idle.sh" "$unit"');
  assert.ok(wait > activation.indexOf('systemctl stop career-dashboard-acquisition.service'));
  assert.ok(wait < activation.indexOf('QUIET=0'));
});

test('failed and inactive units are idle, but unreadable, unknown and long-running units block release', () => {
  for (const state of ['inactive', 'failed']) assert.equal(drain([state]).status, 0);
  for (const state of ['query-error', 'unexpected-state', '']) assert.notEqual(drain([state]).status, 0);
  const timedOut = drain(Array.from({ length: 120 }, () => 'activating'));
  assert.equal(timedOut.status, 1);
  assert.equal(timedOut.reads, 120);
  assert.match(timedOut.stderr, /refusing to continue/);
});
