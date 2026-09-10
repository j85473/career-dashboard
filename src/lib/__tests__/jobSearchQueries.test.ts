import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BODY_AWARE_SEARCH_SOURCES,
  isTerritoryRetailSearchFamily,
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
    'territory manager',
    'territory sales manager',
    'territory sales representative',
    'territory sales executive',
    'regional sales manager',
    'field sales manager',
    'field sales representative',
    'field sales executive',
    'outside sales representative',
    'outside sales manager',
    'territory account manager',
    'distributor account manager',
    'distributor business manager',
    'wholesale account manager',
    'retail account manager',
    'retail business manager',
    'manufacturer sales representative',
    'dealer account manager',
    'key account manager',
    'national account manager',
    'strategic account manager',
    'strategic territory manager',
    'customer sales manager',
  ]);
});

test('paid title discovery stays bounded to channel, network, territory and field roles', () => {
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
    'territory manager',
    'territory sales manager',
    'territory sales representative',
    'territory sales executive',
    'regional sales manager',
    'field sales manager',
    'field sales representative',
    'field sales executive',
    'outside sales representative',
    'outside sales manager',
    'territory account manager',
    'distributor account manager',
    'distributor business manager',
    'wholesale account manager',
    'retail account manager',
    'retail business manager',
    'manufacturer sales representative',
    'dealer account manager',
  ]);
  assert.equal(PAID_JOB_SEARCH_QUERIES.length, 36);
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
    'key account manager',
    'national account manager',
    'strategic account manager',
    'strategic territory manager',
    'customer sales manager',
  ]) {
    assert.equal((PAID_JOB_SEARCH_QUERIES as readonly string[]).includes(title), false, title);
  }
});

test('discovery preference is explicit and independent of title-array order', () => {
  for (const family of ['territory_sales_manager', 'retail_business_manager', 'distributor_account_manager', 'description_independent_retailers']) {
    assert.equal(isTerritoryRetailSearchFamily(family), true, family);
  }
  for (const family of ['channel_account_manager', 'partner_success_manager', 'description_partner_enablement', 'all', null]) {
    assert.equal(isTerritoryRetailSearchFamily(family), false, String(family));
  }
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

test('CareerForce includes territory and field variants alongside its existing titles', () => {
  assert.deepEqual(CAREERFORCE_JOB_SEARCH_QUERIES, [
    'channel account manager',
    'channel partner manager',
    'partner account manager',
    'partner development manager',
    'regional channel manager',
    'channel manager',
    'distribution account manager',
    'distribution sales manager',
    'territory manager',
    'territory sales manager',
    'territory sales representative',
    'territory sales executive',
    'regional sales manager',
    'field sales manager',
    'field sales representative',
    'field sales executive',
    'outside sales representative',
    'outside sales manager',
    'territory account manager',
    'distributor account manager',
    'distributor business manager',
    'wholesale account manager',
    'retail account manager',
    'retail business manager',
    'manufacturer sales representative',
    'dealer account manager',
    'key account manager',
    'national account manager',
    'strategic account manager',
    'strategic territory manager',
    'customer sales manager',
  ]);
  assert.equal(CAREERFORCE_JOB_SEARCH_QUERIES.length, 31);
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
    '"assigned accounts" "territory"',
    '"retail partners" "sales"',
    '"independent retailers"',
    '"distributor relationships"',
    '"product training" "dealers"',
    '"territory growth" "existing accounts"',
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

test('JSearch carries Indeed coverage without scheduling the metadata-only Indeed12 lane', () => {
  assert.equal(PAID_TITLE_SEARCH_SOURCES.includes('JSearch'), true);
  assert.equal(PAID_TITLE_SEARCH_SOURCES.includes('Indeed' as never), false);
  assert.equal(BODY_AWARE_SEARCH_SOURCES.includes('Indeed' as never), false);
});
