import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * A format migration once reset every platform to the oldest index with a
 * single console.log nobody read, discarding months of greenhouse/ashby/lever
 * crawling. These guard the two properties that failure needed.
 */
const crawler = readFileSync('src/scripts/discoverATS.ts', 'utf8');

test('a completed platform is skipped when nothing newer exists', () => {
  assert.match(crawler, /completedThrough/);
  assert.match(crawler, /is complete through .*no newer index published\. Skipping/);
});

test('a completed platform resumes at the next published index', () => {
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
  // Operator state lives in discover_progress.json, which every crawl mutates,
  // so it is not asserted here. What must hold is that the script only ever
  // marks the platforms it was given.
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
