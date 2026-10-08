import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync('scripts/deployment/m70-backup.sh', 'utf8');
const retention = source.slice(source.indexOf('SSD_RETENTION_MINUTES='), source.indexOf('# Failed runs retain'));
const capacity = source.slice(source.indexOf('largest_dump='), source.indexOf('runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs'));
const linux = { skip: process.platform !== 'linux' }; // The production script uses GNU find/stat and Bash mapfile.
const GiB = 1024 ** 3;

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backup-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = path.join(root, 'local');
  const ssd = path.join(root, 'ssd');
  await mkdir(local);
  await mkdir(ssd);
  const run = (body: string) => spawnSync('bash', ['-c', `set -euo pipefail\nDIR="$LOCAL"\nCOPY_DIR="$SSD"\n${body}`], {
    env: { ...process.env, LOCAL: local, SSD: ssd }, encoding: 'utf8',
  });
  return { local, ssd, run };
}

async function set(directory: string, name: string, ageHours = 8 * 24) {
  const stamp = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  for (const [extension, contents] of [['dump', 'database'], ['files.tar.gz', 'files'], ['sha256', 'matching manifest']]) {
    const file = path.join(directory, `${name}.${extension}`);
    await writeFile(file, contents);
    await utimes(file, stamp, stamp);
  }
}

test('expired local duplicates are pruned before SSD retention keeps its three newest complete sets', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02', '03', '04', '05']) {
    await set(local, `m70-202610${day}T081500Z`);
    await set(ssd, `m70-202610${day}T081500Z`);
  }
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(local), []);
  assert.deepEqual((await readdir(ssd)).filter(name => name.endsWith('.sha256')).sort(), [
    'm70-20261003T081500Z.sha256', 'm70-20261004T081500Z.sha256', 'm70-20261005T081500Z.sha256',
  ]);
});

test('both retention checks use seven days without an extra local-copy day', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  await set(local, 'm70-20261001T081500Z', 7 * 24 + 2);
  await set(ssd, 'm70-20261001T081500Z', 7 * 24 + 2);
  await set(local, 'm70-20261002T081500Z', 6 * 24);
  await set(ssd, 'm70-20261002T081500Z', 6 * 24);
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(local)).filter(name => name.endsWith('.sha256')), ['m70-20261002T081500Z.sha256']);
  assert.equal((await readdir(ssd)).filter(name => name.endsWith('.sha256')).length, 2);
});

test('unmatched, incomplete, or conflicting SSD copies cannot erase local recovery points', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02', '03', '04']) await set(local, `m70-202610${day}T081500Z`);
  for (const day of ['02', '03', '04']) await set(ssd, `m70-202610${day}T081500Z`);
  await rm(path.join(ssd, 'm70-20261002T081500Z.files.tar.gz'));
  await writeFile(path.join(ssd, 'm70-20261003T081500Z.sha256'), 'different manifest');
  await writeFile(path.join(ssd, 'm70-20261004T081500Z.dump'), 'different file length');
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(local)).length, 12);
});

async function sparseFile(file: string, size: number) {
  const handle = await open(file, 'w');
  try { await handle.truncate(size); } finally { await handle.close(); }
}

test('cleanup frees staging space before capacity admits one set with growth and reserve', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  const old = 'm70-20261001T081500Z';
  await set(local, old, 7 * 24 + 2);
  await set(ssd, old, 7 * 24 + 2);
  await sparseFile(path.join(local, 'predeploy-20261007T164943Z.dump'), 21 * GiB);
  await sparseFile(path.join(local, 'm70-20261005T081514Z.files.tar.gz'), GiB);
  const df = `df() {
    local available=$((64 * 1024 * 1024 * 1024))
    if [[ "\${@: -1}" == "$DIR" ]]; then
      available=$((47 * 1024 * 1024 * 1024))
      [[ ! -e "$DIR/${old}.dump" ]] || available=$((31 * 1024 * 1024 * 1024))
    fi
    printf 'Avail\\n%s\\n' "$available"
  }`;
  assert.notEqual(run(`${df}\n${capacity}`).status, 0, 'staging is insufficient before cleanup');
  const result = run(`${df}\n${retention}\n${capacity}\nprintf '%s' "$required_bytes"`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout), (21 * GiB + GiB) * 1.25 + 5 * GiB);
});

for (const full of ['local', 'ssd']) {
  test(`capacity fails closed before a dump when the ${full} disk lacks the growth reserve`, linux, async t => {
    const { local, run } = await fixture(t);
    await sparseFile(path.join(local, 'm70-20261005T081514Z.dump'), 19 * GiB);
    await sparseFile(path.join(local, 'predeploy-20261007T164943Z.dump'), 21 * GiB);
    await sparseFile(path.join(local, 'm70-20261005T081514Z.files.tar.gz'), GiB);
    const disk = full === 'local' ? '$DIR' : '$COPY_DIR';
    const result = run(`df() {
      local available=$((64 * 1024 * 1024 * 1024))
      [[ "\${@: -1}" != "${disk}" ]] || available=$((30 * 1024 * 1024 * 1024))
      printf 'Avail\\n%s\\n' "$available"
    }\n${capacity}\necho dump-would-start`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Insufficient free space for a new backup/);
    assert.doesNotMatch(result.stdout, /dump-would-start/);
  });
}
