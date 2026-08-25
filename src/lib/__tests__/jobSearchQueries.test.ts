import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BODY_AWARE_SEARCH_SOURCES,
  CAREERFORCE_JOB_SEARCH_QUERIES,
  DESCRIPTION_LANGUAGE_QUERIES,
  PAID_JOB_SEARCH_QUERIES,
  PAID_TITLE_SEARCH_SOURCES,
  PRIMARY_JOB_SEARCH_QUERIES,
  TRAVEL_LANGUAGE_QUERIES,
} from '../jobSearchQueries';

test('broad source discovery uses the complete target-role search set', () => {
  assert.deepEqual(PRIMARY_JOB_SEARCH_QUERIES, [
    'channel account manager',
    'channel partner manager',
    'channel business manager',
    'channel development manager',
    'partner account manager',
    'partner business manager',
    'partner development manager',
    'partner sales manager',
    'partner growth manager',
    'partner growth sales manager',
    'partner activation manager',
    'partner success manager',
    'regional channel manager',
    'channel manager',
    'distribution account manager',
    'distribution sales manager',
    'dealer development manager',
    'dealer performance manager',
    'territory performance manager',
    'market performance manager',
    'regional performance manager',
    'retail performance manager',
    'franchise performance manager',
    'network performance manager',
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

test('paid title discovery stays bounded to high-precision channel and network roles', () => {
  assert.deepEqual(PAID_JOB_SEARCH_QUERIES, [
    'channel account manager',
    'channel partner manager',
    'channel business manager',
    'channel development manager',
    'partner account manager',
    'partner business manager',
    'partner development manager',
    'partner sales manager',
    'partner growth manager',
    'partner activation manager',
    'partner success manager',
    'regional channel manager',
    'channel manager',
    'distribution account manager',
    'distribution sales manager',
    'dealer development manager',
    'dealer performance manager',
    'territory performance manager',
  ]);
  assert.equal(PAID_JOB_SEARCH_QUERIES.length, 18);
  for (const title of PAID_JOB_SEARCH_QUERIES) {
    assert.ok((PRIMARY_JOB_SEARCH_QUERIES as readonly string[]).includes(title), title);
  }
  for (const title of [
    'partner growth sales manager',
    'market performance manager',
    'regional performance manager',
    'retail performance manager',
    'franchise performance manager',
    'network performance manager',
    'territory sales manager',
    'regional sales manager',
    'field sales manager',
    'key account manager',
    'national account manager',
    'strategic account manager',
    'strategic territory manager',
    'customer sales manager',
  ]) {
    assert.equal((PAID_JOB_SEARCH_QUERIES as readonly string[]).includes(title), false, title);
  }
});

test('channel titles lead the title set ahead of territory and field titles', () => {
  const first = PRIMARY_JOB_SEARCH_QUERIES.indexOf('channel account manager');
  const territory = PRIMARY_JOB_SEARCH_QUERIES.indexOf('territory sales manager');
  assert.equal(first, 0);
  assert.ok(territory > first, 'territory titles must not outrank the claimed channel title');
});

test('partner-growth and distributed-network performance title families stay in discovery', () => {
  for (const title of [
    'partner growth manager',
    'partner growth sales manager',
    'partner activation manager',
    'channel business manager',
    'territory performance manager',
    'dealer performance manager',
    'dealer development manager',
    'network performance manager',
  ]) {
    assert.ok((PRIMARY_JOB_SEARCH_QUERIES as readonly string[]).includes(title), title);
  }
});

test('CareerForce keeps the bounded pre-expansion title portfolio', () => {
  assert.deepEqual(CAREERFORCE_JOB_SEARCH_QUERIES, [
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
  assert.equal(CAREERFORCE_JOB_SEARCH_QUERIES.length, 16);
  for (const title of CAREERFORCE_JOB_SEARCH_QUERIES) {
    assert.ok((PRIMARY_JOB_SEARCH_QUERIES as readonly string[]).includes(title), title);
  }
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

test('travel discovery is bounded and never runs against title-only LinkedIn search', () => {
  assert.deepEqual(TRAVEL_LANGUAGE_QUERIES, [
    '"50% travel" channel sales',
    '"extensive travel" partner sales',
    '"up to 75% travel" territory',
  ]);
  assert.ok(TRAVEL_LANGUAGE_QUERIES.length <= 3);
  assert.equal(PAID_TITLE_SEARCH_SOURCES.includes('LinkedIn'), true);
  assert.equal(BODY_AWARE_SEARCH_SOURCES.includes('LinkedIn' as never), false);
});
