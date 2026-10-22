import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runAtsWebDiscovery } from '../../src/lib/atsWebDiscovery';
import { extractAtsDiscoveryLinks, knownAtsBoardFromUrl, normalizeDiscoveryUrl } from '../../src/lib/atsWebDiscoveryLinks';
import { discoveryRobotsAllows, parseDiscoveryRobots } from '../../src/lib/atsWebDiscoveryRobots';
import { AtsWebDiscoveryState } from '../../src/lib/atsWebDiscoveryState';
import { parseWebDiscoveryArguments, resourcePressure } from '../../scripts/crawl_ats_boards';

function fixture(pages: Record<string, string | { status: number; body?: string; headers?: Record<string, string> }>) {
  let clock = 1_000_000_000;
  const calls: Array<{ url: string; at: number }> = [];
  return {
    calls, now: () => clock, sleep: async (ms: number) => { clock += ms; }, advance: (ms: number) => { clock += ms; },
    request: async (url: string, init: RequestInit, maximumBytes: number) => {
      calls.push({ url, at: clock });
      assert.equal(init.redirect, 'manual');
      assert.ok(maximumBytes <= 2 * 1024 * 1024);
      const entry = pages[url];
      assert.notEqual(entry, undefined, `Unexpected network destination: ${url}`);
      return typeof entry === 'string' ? new Response(entry, { headers: { 'content-type': 'text/html' } })
        : new Response(entry.body || '', { status: entry.status, headers: entry.headers });
    },
  };
}

test('the CPU quota does not turn moderate host load into a permanent discovery pause', () => {
  // M70 reports 12 host CPUs but availableParallelism() is 1 in the crawler's
  // CPUQuota=50% service. Its system load must use the host CPU denominator.
  const resources = { load: 6.99, hostCpuCount: 12, availableMemoryBytes: 24 * 1024 ** 3 };
  assert.equal(resourcePressure(resources), null);
  assert.equal(resourcePressure({ ...resources, load: 10.21 }), 'paused_for_cpu_load');
  assert.equal(resourcePressure({ ...resources, hostCpuCount: 1 }), 'paused_for_cpu_load');
  assert.equal(resourcePressure({ ...resources, availableMemoryBytes: 512 * 1024 ** 2 }), 'paused_for_memory_pressure');
});

test('discovery preserves provider identity while rejecting unsafe navigation', () => {
  const url = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=11111111-1111-1111-1111-111111111111&ccId=ABCD&lang=en_US&utm_source=test#jobs';
  const normalized = normalizeDiscoveryUrl(url)!;
  assert.ok(normalized.includes('ccId=ABCD'));
  assert.ok(!normalized.includes('utm_'));
  assert.ok(!normalized.includes('#'));
  for (const invalid of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'mailto:a@b.com', 'tel:123', 'ftp://example.com',
    'https://jobs.greenhouse.io.evil.test/acme', 'https://user:pass@jobs.lever.co/acme', 'http://100.107.116.123:3000', 'https://localhost/jobs']) {
    assert.equal(knownAtsBoardFromUrl(invalid), null, invalid);
  }
  assert.deepEqual(knownAtsBoardFromUrl('https://jobs.smartrecruiters.com/AcmeCorp/744000'), {
    platform: 'smartrecruiters', slug: 'AcmeCorp', matchedUrl: 'https://jobs.smartrecruiters.com/AcmeCorp/744000',
  });
  assert.equal(knownAtsBoardFromUrl('https://company.example/jobs/123'), null);
  assert.equal(knownAtsBoardFromUrl('https://company.example/careers?gh_jid=123'), null);
});

test('recognizes linked and embedded boards without importing jobs or following nofollow', () => {
  const found = extractAtsDiscoveryLinks(`
    <a href="/careers">Careers</a><a href="https://manufacturer.example/">Member company</a>
    <a href="https://job-boards.greenhouse.io/Acme/jobs/123">Apply</a>
    <iframe src="https://jobs.lever.co/acme"></iframe>
    <script>{"board":"https:\\/\\/jobs.ashbyhq.com\\/Acme"}</script>
    <a rel="nofollow" href="https://jobs.lever.co/skip">Skip</a>
    <a href="javascript:alert(1)">Bad</a><a href="/brochure.pdf">Download</a>
    <form action="/delete-account"></form>`, 'https://directory.example/members');
  assert.deepEqual(found.boards.map(board => `${board.platform}:${board.slug}`).sort(), ['ashby:Acme', 'greenhouse:Acme', 'lever:acme']);
  assert.deepEqual(found.links.map(link => link.url), ['https://directory.example/careers', 'https://manufacturer.example/']);
  assert.deepEqual(extractAtsDiscoveryLinks('<meta name="robots" content="nofollow"><a href="https://jobs.lever.co/acme">Apply</a>', 'https://example.com'), { boards: [], links: [] });
});

test('robots obeys exact bot groups, merged rules, longest match, encoded paths, and allow ties', () => {
  const policy = parseDiscoveryRobots(`User-agent: *
Disallow: /
User-agent: CareerDashboardDiscovery
Disallow: /private
Allow: /private/jobs
Crawl-delay: 12.5
Sitemap: https://example.com/sitemap.xml
User-agent: careerdashboarddiscovery
Disallow: /*.pdf$
Disallow: /caf%C3%A9
Disallow: /equal
Allow: /equal`);
  assert.equal(policy.crawlDelayMs, 12500);
  for (const page of ['/public', '/private/jobs', '/equal', '/file.pdf?download=1']) assert.equal(discoveryRobotsAllows(policy, `https://example.com${page}`), true, page);
  for (const page of ['/private/data', '/file.pdf', '/café']) assert.equal(discoveryRobotsAllows(policy, `https://example.com${page}`), false, page);
  assert.equal(discoveryRobotsAllows(parseDiscoveryRobots('User-agent: *\nDisallow: /'), 'https://example.com/jobs'), false);
  assert.equal(discoveryRobotsAllows(parseDiscoveryRobots('User-agent: OtherBot\nDisallow: /'), 'https://example.com/jobs'), true);
});

test('resumes across passes and discovers a board through directory, employer, and careers links', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ats-web-discovery-'));
  const filename = path.join(directory, 'state.sqlite');
  const network = fixture({
    'https://directory.example/robots.txt': { status: 404 },
    'https://directory.example/members': '<a href="https://maker.example/">Manufacturer</a>',
    'https://maker.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
    'https://maker.example/': '<a href="/careers">Careers</a>',
    'https://maker.example/careers': '<a href="https://job-boards.greenhouse.io/CaseSensitive/jobs/123">Apply</a>',
  });
  let state = new AtsWebDiscoveryState(filename);
  try {
    const first = await runAtsWebDiscovery(state, ['https://directory.example/members'], { maxRequests: 3 }, network);
    assert.equal(first.stopReason, 'request_budget');
    assert.equal(first.pagesVisited, 1);
    assert.deepEqual(state.pendingCandidates(10, network.now()), []);
    state.close();
    state = new AtsWebDiscoveryState(filename);
    const second = await runAtsWebDiscovery(state, [], { maxRequests: 10 }, network);
    assert.equal(second.pagesVisited, 2);
    assert.equal(second.requests, 2, 'cached robots and visited pages are not downloaded again');
    assert.deepEqual(state.pendingCandidates(10, network.now()), [{
      platform: 'greenhouse', slug: 'CaseSensitive', matchedUrl: 'https://job-boards.greenhouse.io/CaseSensitive/jobs/123',
      sourceUrl: 'https://maker.example/careers', attempts: 0,
    }]);
    assert.deepEqual(network.calls.map(call => call.url), [
      'https://directory.example/robots.txt',
      'https://directory.example/members',
      'https://maker.example/robots.txt',
      'https://maker.example/',
      'https://maker.example/careers',
    ], 'discovery visits only the source pages and never collects the job catalogue');
    for (let i = 1; i < network.calls.length; i++) assert.ok(network.calls[i].at - network.calls[i - 1].at >= 1000);
    const employerCalls = network.calls.filter(call => new URL(call.url).hostname === 'maker.example');
    for (let i = 1; i < employerCalls.length; i++) assert.ok(employerCalls[i].at - employerCalls[i - 1].at >= 5000);
  } finally { state.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('robots failures defer pages and never count them as completed or empty', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({ 'https://maker.example/robots.txt': { status: 503 } });
  try {
    const result = await runAtsWebDiscovery(state, ['https://maker.example/'], {}, network);
    assert.equal(result.requests, 1);
    assert.equal(result.pagesVisited, 0);
    assert.deepEqual(result.inventory.pages, [{ status: 'retry', count: 1 }]);
    assert.equal(result.inventory.boards.length, 0);
    assert.equal((await runAtsWebDiscovery(state, [], {}, network)).requests, 0);
  } finally { state.close(); }
});

test('robots redirects apply rules to the original site; page redirects check the destination policy', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({
    'https://source.example/robots.txt': { status: 302, headers: { location: 'https://policy.example/rules' } },
    'https://policy.example/rules': { status: 200, body: 'User-agent: *\nDisallow: /private' },
    'https://source.example/': { status: 302, headers: { location: 'https://destination.example/careers' } },
    'https://destination.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
  });
  try {
    const result = await runAtsWebDiscovery(state, ['https://source.example/', 'https://source.example/private'], {}, network);
    assert.equal(result.requests, 4);
    assert.equal(result.inventory.pages.find(row => row.status === 'blocked')?.count, 2);
    assert.ok(!network.calls.some(call => call.url === 'https://destination.example/careers'));
  } finally { state.close(); }
});

test('429 preserves the page and honors Retry-After without hammering the host', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({
    'https://maker.example/robots.txt': { status: 404 },
    'https://maker.example/': { status: 429, headers: { 'retry-after': '7200' } },
  });
  try {
    const result = await runAtsWebDiscovery(state, ['https://maker.example/'], {}, network);
    assert.equal(result.requests, 2);
    assert.ok(state.nextDue(20, network.now())! >= network.now() + 7200_000);
    network.advance(60 * 60_000);
    assert.equal((await runAtsWebDiscovery(state, [], {}, network)).requests, 0);
  } finally { state.close(); }
});

test('host daily limits leave work queued and allow another site to progress', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({
    'https://one.example/robots.txt': { status: 404 },
    'https://one.example/': '<a href="/careers">Careers</a><a href="https://two.example/">Member</a>',
    'https://two.example/robots.txt': { status: 404 },
    'https://two.example/': '<a href="https://jobs.lever.co/two">Apply</a>',
  });
  try {
    const result = await runAtsWebDiscovery(state, ['https://one.example/'], { requestsPerHostPerDay: 2 }, network);
    assert.equal(result.requests, 4);
    assert.equal(state.pendingCandidates(10, network.now())[0].slug, 'two');
    assert.equal(state.nextPage(network.now(), 2, false), null);
    assert.ok(result.inventory.pages.some(row => row.status === 'queued'));
  } finally { state.close(); }
});

test('page evidence and child discoveries roll back together on a failed commit', () => {
  const state = new AtsWebDiscoveryState(':memory:');
  try {
    state.enqueue('https://maker.example/', 'https://maker.example/', 0, 50, 1_000_000_000, 10);
    assert.throws(() => state.transaction(() => {
      state.recordBoard({ platform: 'lever', slug: 'acme', matchedUrl: 'https://jobs.lever.co/acme' }, 'https://maker.example/', 1_000_000_000);
      state.finishPage('https://maker.example/', 'visited', 2_000_000_000, 200);
      throw new Error('Simulated disk/commit failure');
    }));
    assert.deepEqual(state.pendingCandidates(10, 1_000_000_000), []);
    assert.ok(state.nextPage(1_000_000_000, 20, false));
    assert.equal(state.report().queue.pending, 1);
    assert.equal(state.metric('pendingUrls'), 1, 'rolled-back completion cannot free a queue slot');
  } finally { state.close(); }
});

test('queue caps are reported while known board evidence still survives', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({
    'https://maker.example/robots.txt': { status: 404 },
    'https://maker.example/': '<a href="/careers">Careers</a><a href="/other">Other</a><a href="https://jobs.lever.co/acme">Apply</a>',
    'https://maker.example/careers': '<a href="https://jobs.lever.co/acme">Apply</a>',
  });
  try {
    const result = await runAtsWebDiscovery(state, ['https://maker.example/'], { maxUrls: 1 }, network);
    assert.equal(result.inventory.linksOmittedAtCapacity, 1);
    assert.equal(state.pendingCandidates(10, network.now()).length, 1);
    assert.equal(result.pagesVisited, 2, 'a full queue can follow a child using its completed parent slot');
    assert.deepEqual(result.inventory.queue, { pending: 0, history: 2, retained: 2, limit: 1, available: 1 });
  } finally { state.close(); }
});

test('retained history frees admission capacity without losing deduplication, revisits or retry holds', () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const now = 1_000_000_000;
  const parent = 'https://maker.example/';
  const retry = 'https://held.example/';
  const child = 'https://child.example/';
  try {
    state.enqueue(parent, parent, 0, 50, now, 2);
    state.enqueue(retry, parent, 1, 10, now, 2);
    state.finishPage(retry, 'retry', now + 7200_000, 429, 'HTTP 429');
    assert.equal(state.enqueue(child, parent, 1, 20, now, 2), false);
    state.finishPage(parent, 'visited', now + 7 * 86_400_000, 200);
    assert.equal(state.enqueue(child, parent, 1, 20, now, 2), true);
    assert.equal(state.metric('pendingUrls'), 2);
    assert.deepEqual(state.report(2).queue, { pending: 2, history: 1, retained: 3, limit: 2, available: 0 });
    assert.equal(state.enqueue(parent, child, 0, 60, now, 2), true, 'known history is not admitted twice at capacity');
    state.finishPage(child, 'visited', now + 7 * 86_400_000, 200);
    assert.equal(state.nextPage(now + 1, 20, false), null, 'neither an existing retry hold nor a revisit is shortened');
    assert.equal(state.nextDue(20, now), now + 7200_000);
    assert.equal(state.nextPage(now + 7200_000, 20, false)?.url, retry);
    assert.equal(state.nextPage(now + 7 * 86_400_000, 20, false)?.url, parent, 'visited history still becomes due');
    state.finishPage(parent, 'retry', now + 8 * 86_400_000, 503);
    assert.equal(state.metric('pendingUrls'), 2, 'a failed revisit joins pending work');
  } finally { state.close(); }
});

test('redirects free their parent slot before saving the destination at queue capacity', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({
    'https://maker.example/robots.txt': { status: 404 },
    'https://maker.example/': { status: 302, headers: { location: '/careers' } },
    'https://maker.example/careers': '<a href="https://jobs.lever.co/acme">Apply</a>',
  });
  try {
    const result = await runAtsWebDiscovery(state, ['https://maker.example/'], { maxUrls: 1 }, network);
    assert.equal(result.inventory.linksOmittedAtCapacity, 0);
    assert.equal(state.pendingCandidates(10, network.now()).length, 1);
    assert.deepEqual(result.inventory.queue, { pending: 0, history: 2, retained: 2, limit: 1, available: 1 });
  } finally { state.close(); }
});

test('older state gains queue accounting without rewriting saved evidence or holds', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ats-web-upgrade-'));
  const filename = path.join(directory, 'state.sqlite');
  const now = 1_000_000_000;
  let state = new AtsWebDiscoveryState(filename);
  try {
    for (const [index, status] of ['queued', 'retry', 'visited', 'blocked', 'ignored'].entries()) {
      const url = `https://maker.example/${index}`;
      state.enqueue(url, 'https://directory.example/', 1, 40, now, 10);
      state.finishPage(url, status, now + 86_400_000, status === 'retry' ? 429 : 200, 'retained evidence');
    }
    state.recordBoard({ platform: 'lever', slug: 'acme', matchedUrl: 'https://jobs.lever.co/acme' }, 'https://maker.example/2', now);
    state.saveRobots('https://maker.example', 'User-agent: *\nAllow: /', 'allow', now + 86_400_000, 5000);
    state.cooldown('https://maker.example', now + 7200_000);
    state.setMetric('requests', 17);
    state.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`DROP TRIGGER frontier_pending_insert; DROP TRIGGER frontier_pending_update;
      DROP TRIGGER frontier_pending_delete; DELETE FROM meta WHERE key='pendingUrls';`);
    const tables = ['frontier', 'hosts', 'boards', 'meta', 'lease'];
    const before = Object.fromEntries(tables.map(table => [table, legacy.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
    legacy.close();
    state = new AtsWebDiscoveryState(filename, true);
    assert.deepEqual(state.report(500_000).queue, { pending: 2, history: 3, retained: 5, limit: 500_000, available: 499_998 });
    assert.equal(state.metric('pendingUrls'), 0, 'read-only status does not create the new counter');
    state.close();
    state = new AtsWebDiscoveryState(filename);
    assert.equal(state.metric('pendingUrls'), 2);
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    for (const table of tables) {
      const after = upgraded.prepare(`SELECT * FROM ${table} ${table === 'meta' ? "WHERE key!='pendingUrls'" : ''} ORDER BY 1`).all();
      assert.deepEqual(after, before[table], `${table} evidence survives upgrade unchanged`);
    }
    upgraded.close();
    state.finishPage('https://maker.example/1', 'visited', now + 86_400_000, 200);
    assert.equal(state.metric('pendingUrls'), 1);
    state.close();
    state = new AtsWebDiscoveryState(filename);
    assert.equal(state.metric('pendingUrls'), 1, 'reopening does not duplicate or reset the counter');
  } finally { state.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('retries remain saved above the admission limit while new URLs wait for capacity', () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const now = 1_000_000_000;
  try {
    const known = 'https://known.example/';
    const queued = 'https://queued.example/';
    state.enqueue(known, known, 0, 50, now, 1);
    state.finishPage(known, 'visited', now + 7 * 86_400_000, 200);
    state.enqueue(queued, queued, 0, 50, now, 1);
    state.finishPage(known, 'retry', now + 8 * 86_400_000, 503);
    assert.deepEqual(state.report(1).queue, { pending: 2, history: 0, retained: 2, limit: 1, available: 0 });
    assert.equal(state.enqueue('https://new.example/', queued, 1, 50, now, 1), false);
    assert.equal(state.nextDue(20, now), 0, 'the existing queued page remains eligible');
    assert.equal(state.nextPage(now, 20, false)?.url, queued);
  } finally { state.close(); }
});

test('pressure pauses before networking and invalid numeric settings fail before work', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const network = fixture({});
  try {
    const result = await runAtsWebDiscovery(state, ['https://maker.example/'], {}, { ...network, pressure: () => 'paused_for_cpu_load' });
    assert.equal(result.requests, 0);
    assert.equal(result.stopReason, 'paused_for_cpu_load');
    for (const invalid of [NaN, Infinity, -1, 1.5]) await assert.rejects(() => runAtsWebDiscovery(state, [], { maxRequests: invalid }, network));
    for (const invalid of ['NaN', 'Infinity', '-1', '1.5']) assert.throws(() => parseWebDiscoveryArguments(['--max-requests', invalid]));
    assert.throws(() => parseWebDiscoveryArguments(['--max-requests']));
    assert.throws(() => parseWebDiscoveryArguments(['--unknown']));
  } finally { state.close(); }
});

test('only one worker owns a state file, and a crashed lease can expire', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ats-web-lease-'));
  const filename = path.join(directory, 'state.sqlite');
  const first = new AtsWebDiscoveryState(filename);
  const second = new AtsWebDiscoveryState(filename);
  try {
    first.acquire(1_000_000_000);
    assert.throws(() => second.acquire(1_000_000_001), /Another/);
    second.acquire(1_000_120_001);
    assert.throws(() => first.renew(1_000_120_002), /lost/);
    first.release();
    assert.throws(() => first.acquire(1_000_120_003), /Another/);
    second.release();
    first.acquire(1_000_120_004);
    first.release();
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});
