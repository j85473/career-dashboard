import assert from 'node:assert/strict';
import test from 'node:test';
import { DESCRIPTION_LANGUAGE_QUERIES, PRIMARY_JOB_SEARCH_QUERIES } from '../jobSearchQueries';

test('production ingestion uses only the precise target-role search set', () => {
  assert.deepEqual(PRIMARY_JOB_SEARCH_QUERIES, [
    'channel account manager',
    'channel partner manager',
    'partner account manager',
    'partner development manager',
    'regional channel manager',
    'channel manager',
    'distribution account manager',
    'distribution sales manager',
    'territory sales manager',
    'regional sales manager',
    'field sales manager',
    'key account manager',
    'national account manager',
    'strategic account manager',
    'strategic territory manager',
    'customer sales manager',
  ]);
});

test('channel titles lead the title set ahead of territory and field titles', () => {
  const first = PRIMARY_JOB_SEARCH_QUERIES.indexOf('channel account manager');
  const territory = PRIMARY_JOB_SEARCH_QUERIES.indexOf('territory sales manager');
  assert.equal(first, 0);
  assert.ok(territory > first, 'territory titles must not outrank the claimed channel title');
});

test('description-language queries stay separate from the title set', () => {
  assert.deepEqual(DESCRIPTION_LANGUAGE_QUERIES, [
    'two-tier distribution',
    'sell-through',
    'distributor management',
    'authorized reseller',
    'channel partner program',
    'partner enablement',
    'indirect channel',
    'master agent',
    'MDF',
  ]);
  for (const phrase of DESCRIPTION_LANGUAGE_QUERIES) {
    assert.equal(
      (PRIMARY_JOB_SEARCH_QUERIES as readonly string[]).includes(phrase),
      false,
      `${phrase} is body language, not a title query`,
    );
  }
});
