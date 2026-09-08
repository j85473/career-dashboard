import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * A format migration once reset every platform to the oldest index with a
 * single console.log nobody read, discarding months of greenhouse/ashby/lever
 * crawling. These guard the two properties that failure needed.
 */
const crawler = readFileSync('src/scripts/discoverATS.ts', 'utf8');

test('a completed pattern is skipped when nothing newer exists', () => {
  assert.match(crawler, /completedThrough/);
  assert.match(crawler, /is complete through .*no newer index published\. Skipping/);
});

test('a completed pattern resumes at the next published index', () => {
  // Marking complete must not retire a platform: new monthly indices still get
  // crawled.
  assert.match(crawler, /indices\[completedIdx \+ 1\]/);
});

test('finishing every index records the completion', () => {
  // Without this the next run walks all 126 indices again.
  assert.match(crawler, /completedThrough: indices\[indices\.length - 1\]/);
});

test('a legacy progress file is backed up and reported loudly', () => {
  // The original branch logged one line and silently reset everything.
  assert.match(crawler, /legacy-\$\{Date\.now\(\)\}/);
  assert.match(crawler, /console\.error/);
  assert.doesNotMatch(crawler, /console\.log\("\[Migration\] Old progress file format detected\. Starting fresh\."\)/);
});

test('the mark-complete script never invents progress for a new platform', () => {
  // Operator state lives in the database, which every crawl mutates, so it is
  // not asserted here. What must hold is that the script only ever marks the
  // platforms it was given.
  const script = readFileSync('scripts/mark_ats_platforms_crawled.ts', 'utf8');
  assert.match(script, /const platforms = named\.length > 0 \? named : DEFAULT_PLATFORMS/);
  // Newly wired platforms are absent from the default list, so a bare run
  // cannot skip the history they still need to crawl.
  for (const platform of ['breezy', 'teamtailor', 'pinpoint', 'recruitee', 'rippling', 'personio']) {
    assert.doesNotMatch(script.slice(script.indexOf('DEFAULT_PLATFORMS = ['), script.indexOf('];')), new RegExp(`'${platform}'`));
  }
  // And it refuses to write without an explicit flag.
  assert.match(script, /Preview only\. Re-run with --apply to write\./);
});

test('a failed index request never advances progress', () => {
  // Any error used to return an empty array, which the caller reads as "this
  // index holds nothing more" — so a single 503 from Common Crawl's index
  // server permanently skipped an entire index, and a 503 on the newest index
  // marked the platform fully crawled having read nothing.
  assert.match(crawler, /type CrawlPage\s*=/);
  assert.match(crawler, /\{ ok: false; reason: string \}/);
  assert.match(crawler, /if \(!page\.ok\) \{/);
  assert.match(crawler, /Leaving progress at this page/);
  // Only the index server's own end-of-results codes count as "no more data".
  assert.match(crawler, /if \(response\.status === 404 \|\| response\.status === 400\) return \{ ok: true, records: \[\] \}/);
});

test('progress is stored in the database, not the working directory', () => {
  // The dashboard host and a developer's laptop each kept their own
  // discover_progress.json, so "how far have we crawled" depended on which
  // machine you asked, and a deploy from a different directory restarted a
  // 127-index walk.
  assert.match(crawler, /prisma\.atsDiscoveryProgress\.findMany\(\)/);
  assert.match(crawler, /prisma\.atsDiscoveryProgress\.upsert/);
  assert.match(crawler, /await loadProgress\(\)/);
  assert.doesNotMatch(crawler, /fs\.writeFileSync\(PROGRESS_FILE/);
});

test('an existing progress file is imported once and never rewinds the database', () => {
  const importRegion = crawler.slice(crawler.indexOf('async function loadProgress'));
  assert.match(importRegion, /if \(progressTracker\[key\]\) continue;/);
});

test('each pattern keeps its own place in Common Crawl history', () => {
  // Greenhouse's second host was added after the first was walked end to end.
  // Sharing one marker per platform would have made the resume block jump the
  // new host straight to the newest index, skipping ~126 indices of its
  // history without ever requesting them.
  assert.match(crawler, /progressKey = \(platform: string, pattern: string\)/);
  assert.match(crawler, /for \(const pattern of patternsFor\(platform\)\) \{/);
  assert.match(crawler, /let currentState = progressTracker\[key\] \|\| \{ indexId: indices\[0\], page: 0 \}/);
  assert.match(crawler, /where: \{ platform_pattern: \{ platform, pattern \} \}/);
});

test('the legacy progress file lands on the pattern that earned it', () => {
  // The file predates multi-host platforms, so its per-platform state belongs
  // to the first pattern only. Spreading it across every pattern would hand a
  // newly added host a completion marker it never earned.
  const importRegion = crawler.slice(crawler.indexOf('function readLegacyProgressFile'));
  assert.match(importRegion, /progressKey\(platformKey, patternsFor\(platform\)\[0\]\)/);
});

test('rolling from one index to the next is rate limited like any other page', () => {
  // A pattern for a host that did not exist in 2008 walks ~100 empty indices
  // in a row. Firing those back to back is exactly what makes the index server
  // answer 503, which now ends the run for that pattern.
  const rollover = crawler.slice(crawler.indexOf('Rolling over to next index'));
  const nextIndexBranch = rollover.slice(0, rollover.indexOf('Exhausted all available'));
  assert.match(nextIndexBranch, /await delay\(5000\);\n\s*continue;/);
});

test('a throttled vendor does not park a real board forever', () => {
  // validateSlug's dedup skips any slug that already has a row, so a 429 that
  // wrote a 'parked' row retired a live board permanently.
  assert.match(crawler, /const TRANSIENT_STATUSES = new Set\(/);
  assert.match(crawler, /if \(result\.transient\) \{/);
  assert.match(crawler, /Skipped, vendor unavailable/);
});

test('discovery does not apply a region filter of its own', () => {
  // It answers "is this a real board that publishes jobs". Which jobs are worth
  // keeping is the ingestion location gate's call, made against every posting
  // rather than the first API page.
  assert.doesNotMatch(crawler, /LOCATION_KEYWORDS/);
  assert.doesNotMatch(crawler, /No jobs in target region/);
});
