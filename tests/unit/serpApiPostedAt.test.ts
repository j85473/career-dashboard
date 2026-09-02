import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { serpApiPostedAtAgeMs } from '../../src/lib/jobIngestion';

test('reads the relative age Google renders on a jobs result', () => {
  assert.equal(serpApiPostedAtAgeMs('27 days ago'), 27 * 86_400_000);
  assert.equal(serpApiPostedAtAgeMs('3 hours ago'), 3 * 3_600_000);
  assert.equal(serpApiPostedAtAgeMs('1 week ago'), 604_800_000);
  assert.equal(serpApiPostedAtAgeMs('45 minutes ago'), 45 * 60_000);
  assert.equal(serpApiPostedAtAgeMs('2 months ago'), 2 * 2_592_000_000);
  // Google pads long ages and uses words for the recent end.
  assert.equal(serpApiPostedAtAgeMs('30+ days ago'), 30 * 86_400_000);
  assert.equal(serpApiPostedAtAgeMs('Yesterday'), 86_400_000);
  assert.equal(serpApiPostedAtAgeMs('Just posted'), 0);
});

test('returns null rather than inventing an age it does not have', () => {
  // Google omits posted_at for most rows; the caller must be able to tell that
  // apart from a genuine "posted now", or every undated result claims today.
  for (const value of [undefined, null, '', '   ', 'sometime', 42, {}, 'ago', '-3 days ago']) {
    assert.equal(serpApiPostedAtAgeMs(value), null, `should not parse ${JSON.stringify(value)}`);
  }
});

test('the retired date_posted chip is not reintroduced', () => {
  const source = readFileSync(path.resolve('src/lib/jobIngestion.ts'), 'utf8');
  // Google replaced this encoding with an opaque per-query uds token and
  // dropped "Today" as an option entirely. Verified against the live API:
  // sending the old chip returned 0 results where omitting it returned 10, and
  // every SerpApi run from 2026-08-21 onward yielded nothing while still
  // spending the daily budget.
  // Matches the parameter, not the prose: the comment above it explains why.
  assert.doesNotMatch(source, /chips:\s*["']date_posted/);
  // The old code assumed the chip guaranteed same-day results.
  assert.doesNotMatch(source, /const postedAt = new Date\(\); \/\/ Google jobs/);
  assert.match(source, /serpApiPostedAtAgeMs\(job\.detected_extensions\?\.posted_at\)/);
});
