import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { snapshotBackupRuntime } from '../../scripts/deployment/snapshot-backup-runtime.mjs';
import { companyLogoCacheKey, createCompanyLogoCache, createCompanyLogoStore } from '../../src/lib/companyLogoCache';

test('the runtime backup retains saved logo bytes that can be used after a restore with external sources offline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'company-logo-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'runtime'), destination = path.join(root, 'snapshot');
  await mkdir(source);
  await writeFile(path.join(source, 'ats-watchdog-repairs.json'), '{}');
  const subject = { company: 'Example Labs', url: 'https://jobs.ashbyhq.com/example/42' };
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#2468ac' } }).png().toBuffer();
  const asset = { version: 1 as const, key: companyLogoCacheKey(subject), verifiedAt: Date.now(), sourceUrl: 'https://cdn.example.org/logo.png', png };
  await createCompanyLogoStore(path.join(source, 'company-logos')).write(asset);
  await snapshotBackupRuntime(source, destination);
  const restored = createCompanyLogoCache({ store: createCompanyLogoStore(path.join(destination, 'company-logos')),
    sources: async function* () { assert.fail('restored logos must not need the network'); } });
  assert.deepEqual((await restored.get(subject))?.png, png);
  assert.equal(await readFile(path.join(destination, 'ats-watchdog-repairs.json'), 'utf8'), '{}');
});

test('optional missing, partial, corrupt and symlinked logo cache entries do not break retained recovery history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'company-logo-backup-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'runtime'), destination = path.join(root, 'snapshot');
  await mkdir(source);
  await writeFile(path.join(source, 'ats-watchdog-repairs.json'), '{}');
  await snapshotBackupRuntime(source, destination);
  const logos = path.join(source, 'company-logos');
  await mkdir(logos);
  await writeFile(path.join(logos, `${'a'.repeat(64)}.json`), '{broken');
  await writeFile(path.join(logos, `${'b'.repeat(64)}.json`), JSON.stringify({ version: 1, key: 'b'.repeat(64), verifiedAt: 1, sourceUrl: 'https://example.org', png: 'aHRtbA==' }));
  await writeFile(path.join(logos, 'pending.tmp'), 'incomplete');
  await symlink(path.join(source, 'ats-watchdog-repairs.json'), path.join(logos, `${'c'.repeat(64)}.json`));
  await snapshotBackupRuntime(source, destination);
  assert.deepEqual(await readdir(destination), ['ats-watchdog-repairs.json']);
});
