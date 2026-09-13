import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshotBackupRuntime } from '../../scripts/deployment/snapshot-backup-runtime.mjs';

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backup-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'snapshot');
  await mkdir(source);
  return { source, destination };
}

test('recovery snapshots retain repair limits and discovery progress without live coordination files', async (t) => {
  const { source, destination } = await fixture(t);
  const ledger = '{"resume_batches":["2026-09-13T12:00:00Z"]}';
  await writeFile(path.join(source, 'ats-watchdog-repairs.json'), ledger);
  await writeFile(path.join(source, 'discover_progress.json'), '{"offset":42}');
  await writeFile(path.join(source, 'pipeline-state.json'), '{"isRunning":true}');
  await writeFile(path.join(source, 'schedule.lock'), '');
  await snapshotBackupRuntime(source, destination);
  await writeFile(path.join(source, 'ats-watchdog-repairs.json'), '{}');
  assert.deepEqual((await readdir(destination)).sort(), ['ats-watchdog-repairs.json', 'discover_progress.json']);
  assert.equal(await readFile(path.join(destination, 'ats-watchdog-repairs.json'), 'utf8'), ledger);
  assert.equal(await readFile(path.join(destination, 'discover_progress.json'), 'utf8'), '{"offset":42}');
});

test('backup fails closed on missing or invalid repair history', async (t) => {
  const { source, destination } = await fixture(t);
  await assert.rejects(snapshotBackupRuntime(source, destination), /Cannot snapshot/);
  for (const contents of ['{', '[]', '{"resume_batches":["invalid-date"]}']) {
    await writeFile(path.join(source, 'ats-watchdog-repairs.json'), contents);
    await assert.rejects(snapshotBackupRuntime(source, destination), /Cannot snapshot/);
  }
  await writeFile(path.join(source, 'ats-watchdog-repairs.json'), '{}');
  await snapshotBackupRuntime(source, destination);
  assert.deepEqual(await readdir(destination), ['ats-watchdog-repairs.json']);
});

test('GNU tar restores snapshot history to data/runtime while excluding live runtime files', {
  skip: !spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar'),
}, async (t) => {
  const { source, destination } = await fixture(t);
  await mkdir(path.join(source, 'data/runtime'), { recursive: true });
  await writeFile(path.join(source, 'data/runtime/pipeline-state.json'), '{"isRunning":true}');
  await writeFile(path.join(source, 'data/resume.txt'), 'candidate evidence');
  const snapshot = path.join(destination, 'runtime-snapshot');
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, 'ats-watchdog-repairs.json'), '{"resume_batches":[]}');
  const archive = path.join(destination, 'files.tar.gz');
  const created = spawnSync('tar', [
    '--dereference', '--exclude=data/runtime', '--transform=s,^runtime-snapshot,data/runtime,',
    '-czf', archive, '-C', source, 'data', '-C', destination, 'runtime-snapshot',
  ], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const contents = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(contents.status, 0, contents.stderr);
  assert.match(contents.stdout, /data\/runtime\/ats-watchdog-repairs.json/);
  assert.match(contents.stdout, /data\/resume.txt/);
  assert.doesNotMatch(contents.stdout, /pipeline-state|runtime-snapshot/);
  const restored = spawnSync('tar', ['-xOzf', archive, 'data/runtime/ats-watchdog-repairs.json'], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, '{"resume_batches":[]}');
});
