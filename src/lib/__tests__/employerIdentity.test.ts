import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEmployerRuleIndex,
  employerAliasKey,
  employerIdentityKey,
  employerLabelKey,
  employerNameRelation,
  presentableEmployerName,
  resolveEmployer,
  sameEmployer,
  type EmployerRule,
} from '../employerIdentity';

// Every pair below is a real production spelling from the 2026-09-25 census.

test('spellings that differ only in formatting share one key', () => {
  for (const group of [
    ['SPS Commerce, Inc.', 'SPS Commerce Inc', 'SPS Commerce', 'spscommerce.wd108', 'Spscommerce'],
    ['HP Inc.', 'HP', 'hp.wd5', 'Hp'],
    ['McKesson', 'mckesson4', 'MCKESSON', 'mckesson.wd3'],
    ['Arctic Wolf', 'arcticwolf', 'arcticwolf.wd1'],
    ['SharkNinja', 'SharkNinja Operating LLC', 'sharkninjaoperatingllc'],
    ['Pax8', 'Pax8, Inc.', 'pax8inc.wd12'],
    ['The Coca-Cola Company', 'Coca-Cola Company', 'Coca Cola'],
    ['Nilfisk', 'USA-NILIN Nilfisk, Inc.', 'nilfisk.wd3'],
    ['Floor & Decor', 'Floor &amp; Decor'],
    ['Graco', 'graco.wd501.myworkdayjobs.com', 'Graco Inc.'],
  ]) {
    const keys = new Set(group.map(employerAliasKey));
    assert.equal(keys.size, 1, `${group.join(' / ')} -> ${[...keys].join(', ')}`);
  }
  assert.notEqual(employerAliasKey('Arctic Wolf'), employerAliasKey('Arctic Wolf Networks'), 'a different name needs evidence');
  assert.notEqual(employerAliasKey('Pax8'), employerAliasKey('Pax'), 'a brand digit is not a board number');
});

test('names that belong together once evidence says so', () => {
  for (const [left, right] of [
    ['Arctic Wolf', 'Arctic Wolf Networks, Inc.'],
    ['Progleasing', 'Progressive Leasing'],
    ['gomotive', 'Motive'],
    ['thedutchie', 'Dutchie'],
    ['lgelectronics', 'LG Electronics North America'],
    ['ZINC Zillow, Inc.', 'Zillow Group'],
    ['The Kraft Heinz Company', 'Kraft Heinz Food Company Company'],
    ['Paycom', 'Paycom Online'],
    ['The Scotts Company LLC', 'Scotts Miracle-Gro'],
    ['Deckers Brands', 'Deckers America, LLC.'],
    ['HP', 'HP Development Company, L.P.'],
    ['Calibrate', 'Calibrate Health, Inc.'],
  ]) {
    assert.equal(employerNameRelation(left, right), 'strong', `${left} / ${right}`);
  }
});

test('reposters, subsidiaries and sister brands are never related, whatever the evidence', () => {
  for (const [left, right] of [
    ['Reebok International, Ltd', 'vmysmartpros'],
    ['Hewlett Packard Enterprise', 'remote nova'],
    ['MarketStar', 'Wasatchproperty'],
    ['VF Corporation', 'Timberland'],
    ['CareMore Health', 'Castlight Health, Inc'],
    ['Vera Whole Health', 'Castlight Health, Inc'],
    ['U.S. Bank', 'Elavon, Inc.'],
    ['Threadneedle group', '00015 Ameriprise Financial Services, LLC.'],
    ['Innovance Inc.', 'Lou-Rich'],
    ['Stevens Equipment Supply', 'Daikin'],
    ['Veralto', 'Alltec Angewandte Laserlicht Technologie GmbH'],
  ]) {
    assert.equal(employerNameRelation(left, right), null, `${left} / ${right}`);
  }
});

test('a two-letter name that adds a real name stays weak', () => {
  assert.equal(employerNameRelation('GE', 'GE HealthCare'), 'short');
  assert.equal(employerNameRelation('Eco Battery', 'Eco Capital Inc'), 'short');
});

function index(rules: Array<Partial<EmployerRule> & { matchType: string; matchKey: string; standardName: string }>) {
  return buildEmployerRuleIndex(rules.map((rule) => ({ origin: 'manual', ...rule })));
}

test('resolution order: Joseph\'s spelling, his names, learned names, the employer site, the label', () => {
  const rules = index([
    { matchType: 'label', matchKey: employerLabelKey('The Flex Company'), standardName: 'The Flex Company' },
    { matchType: 'employer', matchKey: 'flex', standardName: 'Flex', origin: 'learned' },
    { matchType: 'alias', matchKey: 'prudential', standardName: 'Prudential Financial' },
    { matchType: 'employer', matchKey: 'arcticwolfnetworks', standardName: 'Arctic Wolf', origin: 'learned' },
    { matchType: 'employer_url', matchKey: 'workday:vf.wd5.myworkdayjobs.com', standardName: 'VF', origin: 'learned' },
  ]);
  assert.equal(resolveEmployer({ company: 'The Flex Company' }, rules), 'The Flex Company');
  assert.equal(resolveEmployer({ company: 'Flex' }, rules), 'Flex');
  assert.equal(resolveEmployer({ company: 'Prudential' }, rules), 'Prudential Financial');
  assert.equal(resolveEmployer({ company: 'Arctic Wolf Networks, Inc.' }, rules), 'Arctic Wolf');
  assert.equal(resolveEmployer({ company: 'VF Outdoor, LLC', url: 'https://vf.wd5.myworkdayjobs.com/en-US/vfc/job/1' }, rules), 'VF');
  // A subsidiary on its parent's tenant keeps its own name.
  assert.equal(resolveEmployer({ company: 'Timberland', url: 'https://vf.wd5.myworkdayjobs.com/en-US/vfc/job/2' }, rules), 'Timberland');
  assert.equal(resolveEmployer({ company: 'hp.wd5', source: 'ATS-workday' }, rules), 'Hp');
  assert.equal(resolveEmployer({ company: 'SPS Commerce, Inc.' }, rules), 'SPS Commerce');
});

test('every comparison reads the canonical employer and falls back to the label', () => {
  assert.ok(sameEmployer({ employer: 'Arctic Wolf', company: 'arcticwolf.wd1' }, { employer: 'Arctic Wolf', company: 'Arctic Wolf Networks' }));
  assert.ok(sameEmployer({ employer: null, company: 'HP Inc.' }, { employer: 'HP', company: 'Hp' }));
  assert.ok(sameEmployer({ company: '110 - Zoetis US LLC' }, { company: 'Zoetis' }), 'reviewed profile applies before resolution');
  assert.ok(!sameEmployer({ employer: 'Spectrum', company: 'Spectrum' }, { employer: 'Spectrum Brands', company: 'Spectrum Brands, Inc' }));
  assert.equal(employerIdentityKey({ company: '' }), '');
  assert.equal(presentableEmployerName('Floor &amp; Decor'), 'Floor & Decor');
});

test('a rename is keyed on the source\'s spelling; a split pins both names apart', async () => {
  const { recordCompanyNameCorrection, recordEmployerSplit } = await import('../companyNameStandardization');
  const writes: Array<{ matchType: string; matchKey: string; standardName: string; origin: string }> = [];
  const store = { companyNameRule: { upsert: async (args: { create: { matchType: string; matchKey: string; standardName: string; origin: string } }) => {
    writes.push(args.create);
    return args.create;
  } } } as never;

  // Renaming "Paycom Online" to "Paycom" renames the group it showed under.
  await recordCompanyNameCorrection(store, { priorName: 'Paycom Payroll Llc', standardName: 'Paycom', priorEmployer: 'Paycom Online', jobId: 'job-1' });
  const renamed = new Map(writes.filter((write) => write.matchType === 'employer').map((write) => [write.matchKey, write.standardName]));
  assert.equal(renamed.get('paycompayroll'), 'Paycom');
  assert.equal(renamed.get('paycomonline'), 'Paycom');
  assert.ok(writes.every((write) => write.origin === 'manual'));

  // "Not Spectrum Brands?" on a card whose own spelling is "Spectrum".
  writes.length = 0;
  const own = await recordEmployerSplit(store, { company: 'Spectrum', groupEmployer: 'Spectrum Brands', jobId: 'job-2' });
  assert.equal(own, 'Spectrum');
  const split = new Map(writes.map((write) => [`${write.matchType}:${write.matchKey}`, write.standardName]));
  assert.equal(split.get('label:spectrum'), 'Spectrum');
  assert.equal(split.get('employer:spectrum'), 'Spectrum');
  assert.equal(split.get('employer:spectrumbrands'), 'Spectrum Brands', 'the group keeps its own name');
  assert.ok(![...split.entries()].some(([key, name]) => key.endsWith('spectrumbrands') && name === 'Spectrum'), 'never renames the other employer');

  // Two businesses whose names clean up alike: only the exact spelling is pinned.
  writes.length = 0;
  await recordEmployerSplit(store, { company: 'The Flex Company', groupEmployer: 'Flex', jobId: 'job-3' });
  assert.deepEqual(writes.map((write) => `${write.matchType}:${write.matchKey}=${write.standardName}`), ['label:the flex company=The Flex Company']);
});
