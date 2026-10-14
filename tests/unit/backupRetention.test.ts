import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync('scripts/deployment/m70-backup.sh', 'utf8');
const retention = source.slice(source.indexOf('RECOVERY_POINTS=3'), source.indexOf('# Failed runs retain'));
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
  const run = (body: string) => spawnSync('bash', ['-c', `set -euo pipefail\nDIR="$LOCAL"\nCOPY_DIR="$SSD"\npg_restore() { [[ $(head -c 7 "\${@: -1}") != corrupt ]]; }\n${body}`], {
    env: { ...process.env, LOCAL: local, SSD: ssd }, encoding: 'utf8',
  });
  return { local, ssd, run };
}

async function set(directory: string, name: string, ageHours = 8 * 24) {
  const stamp = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  const digest = (body: string) => createHash('sha256').update(body).digest('hex');
  const manifest = `${digest('database')}  ${name}.dump\n${digest('files')}  ${name}.files.tar.gz\n`;
  for (const [extension, contents] of [['dump', 'database'], ['files.tar.gz', 'files'], ['sha256', manifest]]) {
    const file = path.join(directory, `${name}.${extension}`);
    await writeFile(file, contents);
    await utimes(file, stamp, stamp);
  }
}

test('keep the three newest verified nightly sets even when all five are less than one day old', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02', '03', '04', '05']) {
    await set(local, `m70-202610${day}T081500Z`, 12);
    await set(ssd, `m70-202610${day}T081500Z`, 12);
  }
  let result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  const expected = ['03', '04', '05'].map(day => `m70-202610${day}T081500Z.sha256`);
  for (const directory of [local, ssd]) assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.sha256')).sort(), expected);
  // Publishing another verified set trims the former third point afterwards.
  await set(local, 'm70-20261006T081500Z', 0);
  await set(ssd, 'm70-20261006T081500Z', 0);
  result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(ssd)).filter(name => name.endsWith('.sha256')).sort(),
    ['04', '05', '06'].map(day => `m70-202610${day}T081500Z.sha256`));
});

test('fewer than three complete sets survive indefinitely and incomplete new sets do not displace them', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02']) {
    await set(local, `m70-202610${day}T081500Z`, 365 * 24);
    await set(ssd, `m70-202610${day}T081500Z`, 365 * 24);
  }
  await writeFile(path.join(ssd, 'm70-20261003T081500Z.dump'), 'unfinished dump');
  await writeFile(path.join(ssd, 'm70-20261003T081500Z.sha256'), 'incomplete');
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(local)).length, 6);
  assert.equal((await readdir(ssd)).length, 8);
});

test('a corrupt retained archive stops cleanup before deleting any older recovery point', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02', '03', '04', '05']) {
    await set(local, `m70-202610${day}T081500Z`);
    await set(ssd, `m70-202610${day}T081500Z`);
  }
  await writeFile(path.join(ssd, 'm70-20261005T081500Z.dump'), 'corrupted');
  const result = run(retention);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Retained backup failed verification/);
  assert.equal((await readdir(local)).length, 15);
  assert.equal((await readdir(ssd)).length, 15);
});

test('unmatched, incomplete or conflicting local archives remain protected during count retention', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  for (const day of ['01', '02', '03', '04', '05', '06']) await set(local, `m70-202610${day}T081500Z`);
  for (const day of ['02', '03', '04', '05', '06']) await set(ssd, `m70-202610${day}T081500Z`);
  await writeFile(path.join(local, 'm70-20261002T081500Z.sha256'), 'different manifest');
  await rm(path.join(local, 'm70-20261003T081500Z.files.tar.gz'));
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(local)).length, 17);
  assert.equal((await readdir(ssd)).filter(name => name.endsWith('.sha256')).length, 3);
});

test('predeployment retention keeps three readable older archives and protects recent or unreadable files', linux, async t => {
  const { local, run } = await fixture(t);
  const age = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const day of ['01', '02', '03', '04', '05', '06', '07']) {
    const file = path.join(local, `predeploy-202610${day}T081500Z.dump`);
    await writeFile(file, day === '06' ? 'corrupt archive' : 'database');
    if (day !== '07') await utimes(file, age, age);
  }
  const result = run(retention);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(local)).sort(), ['03', '04', '05', '06', '07'].map(day => `predeploy-202610${day}T081500Z.dump`));
});

async function sparseFile(file: string, size: number) {
  const handle = await open(file, 'w');
  try { await handle.truncate(size); } finally { await handle.close(); }
}

test('cleanup frees staging space before capacity admits one set with growth and reserve', linux, async t => {
  const { local, ssd, run } = await fixture(t);
  const old = 'm70-20261001T081500Z';
  for (const day of ['01', '02', '03', '04']) {
    await set(local, `m70-202610${day}T081500Z`, 12);
    await set(ssd, `m70-202610${day}T081500Z`, 12);
  }
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
  assert.equal(Number(result.stdout.trim().split('\n').at(-1)), (21 * GiB + GiB) * 1.25 + 5 * GiB);
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
