import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateStoragePressure, type StoragePressure } from '../storagePressure';
import { publicCrawlCapacity } from '../publicCrawlCapacity';

const now = Date.parse('2026-11-05T15:00:00Z');
const GIB = 1024 ** 3;
const snapshot: StoragePressure = { version: 1, checkedAt: new Date(now).toISOString(), level: 'normal',
  freeBytes: 50 * GIB, totalBytes: 234 * GIB, collectionPaused: false, backgroundPaused: false, message: '' };

test('disk pressure pauses collection first and preserves a separate database reserve', () => {
  for (const [free, level, collectionPaused, backgroundPaused] of [
    [50, 'normal', false, false], [35, 'warning', false, false],
    [25, 'collection_paused', true, false], [14, 'critical', true, true],
  ] as const) {
    const actual = evaluateStoragePressure(snapshot, free * GIB, 234 * GIB, now);
    assert.equal(actual.level, level); assert.equal(actual.collectionPaused, collectionPaused);
    assert.equal(actual.backgroundPaused, backgroundPaused);
  }
  assert.equal(evaluateStoragePressure({ ...snapshot, collectionPaused: true }, 35 * GIB, 234 * GIB, now).collectionPaused, true);
});

test('missing, stale, future, malformed and unreadable disk evidence all hold background work', () => {
  for (const state of [null, { ...snapshot, checkedAt: new Date(now - 91_000).toISOString() },
    { ...snapshot, checkedAt: new Date(now + 60_000).toISOString() },
    { ...snapshot, collectionPaused: undefined } as unknown as StoragePressure]) {
    assert.equal(evaluateStoragePressure(state, 60 * GIB, 234 * GIB, now).backgroundPaused, true);
  }
  assert.equal(evaluateStoragePressure(snapshot, null, null, now).backgroundPaused, true);
});

test('temporary compaction space never resumes writers before the files return', () => {
  const actual = evaluateStoragePressure({ ...snapshot, level: 'maintenance' }, 100 * GIB, 234 * GIB, now);
  assert.equal(actual.backgroundPaused, true);
  assert.equal(actual.collectionPaused, true);
  assert.match(actual.message, /compacted/);
  const result = spawnSync('python3', ['-c', `
import importlib.util
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('monitor','scripts/deployment/m70-storage-monitor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def sample(free,maintenance,prior):
 saved={}
 with patch.object(m.socket,'gethostname',return_value='m70'), patch.object(m.os.path,'ismount',return_value=True), patch.object(m.os,'stat',return_value=SimpleNamespace(st_dev=1)), patch.object(m.os,'statvfs',return_value=SimpleNamespace(f_bavail=free,f_frsize=m.GIB,f_blocks=234)), patch.object(m.Path,'exists',return_value=maintenance), patch.object(m,'load',side_effect=lambda path,default: prior if path==m.STATE else []), patch.object(m,'atomic_json',side_effect=lambda path,value: saved.update({str(path):value})):
  m.main()
 return saved[str(m.STATE)]
held=sample(35,True,{'collectionPaused':True})
assert held['level']=='maintenance' and held['backgroundPaused']
released=sample(35,False,held)
assert released['level']=='collection_paused' and not released['backgroundPaused']
temporary=sample(100,True,held)
assert temporary['backgroundPaused'] and temporary['collectionPaused']
finished=sample(45,False,temporary)
assert finished['level']=='normal' and not finished['backgroundPaused'] and not finished['collectionPaused']
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a physical-space pause prevents public crawler admission before any database claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-storage-test-'));
  const originalFile = process.env.CAREER_STORAGE_STATUS_FILE, originalPath = process.env.CAREER_STORAGE_TEST_PATH;
  try {
    process.env.CAREER_STORAGE_STATUS_FILE = join(directory, 'status.json');
    process.env.CAREER_STORAGE_TEST_PATH = directory;
    writeFileSync(process.env.CAREER_STORAGE_STATUS_FILE, JSON.stringify({ ...snapshot,
      checkedAt: new Date().toISOString(), collectionPaused: true }));
    const client = { $queryRaw: async () => { throw new Error('Must not claim while storage is paused'); } };
    assert.equal((await publicCrawlCapacity(client as unknown as Parameters<typeof publicCrawlCapacity>[0])).healthy, false);
  } finally {
    if (originalFile === undefined) delete process.env.CAREER_STORAGE_STATUS_FILE; else process.env.CAREER_STORAGE_STATUS_FILE = originalFile;
    if (originalPath === undefined) delete process.env.CAREER_STORAGE_TEST_PATH; else process.env.CAREER_STORAGE_TEST_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the independent monitor resumes only after the reserve has recovered', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('monitor','scripts/deployment/m70-storage-monitor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.pressure(25*m.GIB,{}) == (False,True)
assert m.pressure(35*m.GIB,{'collectionPaused':True}) == (False,True)
assert m.pressure(40*m.GIB,{'collectionPaused':True}) == (False,False)
assert m.pressure(18*m.GIB,{'backgroundPaused':True}) == (True,True)
assert m.pressure(20*m.GIB,{'backgroundPaused':True}) == (False,True)
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('intake protects the internal SSD as well as the NVMe and verifies both readings', () => {
  const dual = { ...snapshot, hostFreeBytes: 50 * GIB, hostTotalBytes: 439 * GIB };
  assert.equal(evaluateStoragePressure(dual, 60 * GIB, 234 * GIB, now, 25 * GIB).collectionPaused, true);
  assert.equal(evaluateStoragePressure(dual, 60 * GIB, 234 * GIB, now, 14 * GIB).backgroundPaused, true);
  assert.equal(evaluateStoragePressure(dual, 60 * GIB, 234 * GIB, now, 45 * GIB).collectionPaused, false);
  assert.equal(evaluateStoragePressure(dual, 60 * GIB, 234 * GIB, now).level, 'unknown');
});
