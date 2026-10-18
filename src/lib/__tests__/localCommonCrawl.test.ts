import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  downloadLocalCrawlDirectory, localCrawlBlockFile, localCrawlConfig, localCrawlDirectoryUrl,
  localCrawlPatternMatches, localCrawlPlanHash, planLocalCrawl, prepareLocalCrawlWorkspace,
  readLocalCrawlBlock, type LocalCrawlPlan,
} from '../localCommonCrawl';

const indexId = 'CC-MAIN-2026-39-index';
const patterns = [{ platform: 'bamboohr', pattern: '*.bamboohr.com/careers*' }];
const key = 'com,bamboohr,acme)/careers/1 20260910000000';
async function temp(t: TestContext) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cc-local-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
function fixture() {
  const bytes = gzipSync(`${key} ${JSON.stringify({ url: 'https://acme.bamboohr.com/careers/1' })}\n`);
  const plan: LocalCrawlPlan = { version: 1, indexId, patterns, manifestSha256: 'a'.repeat(64), directoryBytes: 100,
    compressedBytes: bytes.length, blocks: [{ key, endKey: 'com,example)/ 20260910000000',
      shard: 'cdx-00001.gz', offset: 100, length: bytes.length, patterns: [0] }] };
  const response = (body: BodyInit = bytes, status = 206, contentRange = `bytes 100-${99 + bytes.length}/10000`) => new Response(body, {
    status, headers: { 'content-length': String(bytes.length), 'content-range': contentRange },
  });
  return { bytes, plan, response };
}

test('sparse selection includes predecessor, overlapping hosts share one block, and final block is retained', async t => {
  const folder = await temp(t); const file = path.join(folder, 'cluster.idx');
  await writeFile(file, [
    'com,aaa)/ 20260101000000\tcdx-00000.gz\t0\t100\t1',
    'com,bamboohr,beta)/ 20260101000000\tcdx-00000.gz\t100\t200\t2',
    'com,zzz)/ 20260101000000\tcdx-00000.gz\t300\t300\t3',
  ].join('\n') + '\n');
  const plan = await planLocalCrawl(file, indexId, [...patterns,
    { platform: 'bamboohr', pattern: '*.bamboohr.com/*' }, { platform: 'other', pattern: 'zzzz.com/*' }]);
  assert.deepEqual(plan.blocks.map(b => [b.offset, b.patterns]), [[0, [0, 1]], [100, [0, 1]], [300, [2]]]);
  assert.equal(plan.compressedBytes, 600);
});

for (const [name, contents] of [
  ['empty', ''],
  ['truncated', 'com,a)/ 20260101000000\tcdx-00000.gz\t0\t100\t1'],
  ['path traversal', 'com,a)/ 20260101000000\t../private.gz\t0\t100\n'],
  ['negative length', 'com,a)/ 20260101000000\tcdx-00000.gz\t0\t-1\n'],
  ['block gap', 'com,a)/ 20260101000000\tcdx-00000.gz\t0\t100\ncom,z)/ 20260101000000\tcdx-00000.gz\t101\t100\n'],
  ['unsorted', 'com,z)/ 20260101000000\tcdx-00000.gz\t0\t100\ncom,a)/ 20260101000000\tcdx-00000.gz\t100\t100\n'],
]) test(`a ${name} directory cannot produce a plan`, async t => {
  const folder = await temp(t); const file = path.join(folder, 'cluster.idx');
  await writeFile(file, contents);
  await assert.rejects(planLocalCrawl(file, indexId, patterns));
});

test('directory selection conservatively handles www canonicalization', async t => {
  const folder = await temp(t); const file = path.join(folder, 'cluster.idx');
  await writeFile(file, 'com,aaa)/ 20260101000000\tcdx-00000.gz\t0\t100\ncom,careers-page)/ 20260101000000\tcdx-00000.gz\t100\t100\ncom,z)/ 20260101000000\tcdx-00000.gz\t200\t100\n');
  const plan = await planLocalCrawl(file, indexId, [{ platform: 'manatal', pattern: 'www.careers-page.com/*' }]);
  assert.deepEqual(plan.blocks.map(b => b.offset), [0, 100]);
});

test('exact filtering rejects unrelated hosts, credentials, apex and wrong paths while retaining query strings', () => {
  assert.equal(localCrawlPatternMatches(patterns[0].pattern, 'https://acme.bamboohr.com/careers?id=1'), true);
  for (const url of ['https://bamboohr.com/careers', 'https://acme.bamboohr.com.attacker.com/careers',
    'https://acme.bamboohr.com@attacker.com/careers', 'https://acme.bamboohr.com/about', 'file://acme.bamboohr.com/careers']) {
    assert.equal(localCrawlPatternMatches(patterns[0].pattern, url), false, url);
  }
});

test('a JSONB object-key reorder preserves the saved plan identity', () => {
  const { plan } = fixture();
  const reordered = JSON.parse(JSON.stringify(plan), (_key, value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(localCrawlPlanHash(plan), localCrawlPlanHash(reordered));
});

test('exact byte ranges decompress, validate boundaries, and reuse a saved block on restart', async t => {
  const folder = await temp(t); const f = fixture(); let requests = 0;
  const fetcher = (async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://data.commoncrawl.org/cc-index/collections/CC-MAIN-2026-39/indexes/cdx-00001.gz');
    assert.equal(new Headers(init?.headers).get('range'), `bytes=100-${99 + f.bytes.length}`);
    return f.response();
  }) as typeof fetch;
  assert.deepEqual(await readLocalCrawlBlock(f.plan, 0, folder, fetcher), [{ url: 'https://acme.bamboohr.com/careers/1' }]);
  await readLocalCrawlBlock(f.plan, 0, folder, fetcher);
  assert.equal(requests, 1);
});

test('identical captures may straddle a compressed-block boundary without losing either block', async t => {
  const folder = await temp(t); const f = fixture();
  f.plan.blocks[0].endKey = key;
  assert.equal((await readLocalCrawlBlock(f.plan, 0, folder, (async () => f.response()) as typeof fetch)).length, 1);
});

for (const failure of ['whole shard', 'wrong range', 'short response', 'corrupt gzip', 'wrong first key'] as const) {
  test(`${failure} cannot be accepted as a downloaded block`, async t => {
    const folder = await temp(t); const f = fixture();
    let body: BodyInit = f.bytes; let status = 206; let range = `bytes 100-${99 + f.bytes.length}/10000`;
    if (failure === 'whole shard') status = 200;
    if (failure === 'wrong range') range = `bytes 101-${100 + f.bytes.length}/10000`;
    if (failure === 'short response') body = f.bytes.subarray(0, -1);
    if (failure === 'corrupt gzip') body = Buffer.alloc(f.bytes.length, 1);
    if (failure === 'wrong first key') f.plan.blocks[0].key = 'com,bamboohr,wrong)/ 20260910000000';
    await assert.rejects(readLocalCrawlBlock(f.plan, 0, folder, (async () => f.response(body, status, range)) as typeof fetch));
    await assert.rejects(readFile(localCrawlBlockFile(folder, localCrawlPlanHash(f.plan), 0)));
  });
}

test('a failed directory download never replaces a previously complete directory', async t => {
  const folder = await temp(t); const file = path.join(folder, `${indexId}.cluster.idx`);
  await writeFile(file, 'previous complete directory');
  await assert.rejects(downloadLocalCrawlDirectory(folder, indexId, (async () => new Response('short', {
    headers: { 'content-length': '100' },
  })) as typeof fetch), /truncated/);
  assert.equal(await readFile(file, 'utf8'), 'previous complete directory');
});

test('scratch refuses the OS filesystem, missing mounts and invalid safety limits', async t => {
  const folder = await temp(t);
  await assert.rejects(prepareLocalCrawlWorkspace(localCrawlConfig({ ATS_DISCOVERY_LOCAL_MOUNT: folder })), /mounted drive/);
  await assert.rejects(prepareLocalCrawlWorkspace(localCrawlConfig({ ATS_DISCOVERY_LOCAL_MOUNT: path.join(folder, 'missing') })));
  assert.throws(() => localCrawlConfig({ ATS_DISCOVERY_LOCAL_MOUNT: '/' }));
  assert.throws(() => localCrawlConfig({ ATS_DISCOVERY_LOCAL_RESERVE_BYTES: '-1' }));
  assert.throws(() => localCrawlConfig({ ATS_DISCOVERY_LOCAL_DELAY_MS: '0' }));
});

test('legacy collections use the same public file endpoint and arbitrary paths are rejected', () => {
  assert.match(localCrawlDirectoryUrl('CC-MAIN-2008-2009-index'), /CC-MAIN-2008-2009\/indexes\/cluster.idx$/);
  assert.match(localCrawlDirectoryUrl('CC-MAIN-2012-index'), /CC-MAIN-2012\/indexes\/cluster.idx$/);
  assert.throws(() => localCrawlDirectoryUrl('../../private'));
});
