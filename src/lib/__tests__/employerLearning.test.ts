import assert from 'node:assert/strict';
import test from 'node:test';

import { employerAliasKey } from '../employerIdentity';
import {
  planEmployerLearning,
  type EmployerPin,
  type LabelObservation,
  type PostingLink,
} from '../employerLearning';

function label(company: string, source: string, rows = 1, urlKeys: string[] = []): LabelObservation {
  return { company, source, rows, urlKeys };
}

function posting(left: string, right: string, id = `${left}|${right}`): PostingLink {
  return { left, right, jobIds: [`${id}:a`, `${id}:b`], containment: 0.99 };
}

function plan(input: { labels: LabelObservation[]; postings?: PostingLink[]; pins?: EmployerPin[]; labelPins?: Array<{ label: string; name: string }>; manualKeys?: Set<string> }) {
  return planEmployerLearning({ postings: [], pins: [], ...input });
}

function nameOf(result: ReturnType<typeof plan>, company: string): string | undefined {
  return result.rules.find((rule) => rule.matchType === 'employer' && rule.matchKey === employerAliasKey(company))?.standardName;
}

const ARCTIC_WOLF_TENANT = 'workday:arcticwolf.wd1.myworkdayjobs.com';

test('the same employer site joins related spellings under the brand aggregators use', () => {
  const result = plan({ labels: [
    label('Arctic Wolf', 'LinkedIn (Apify)', 5),
    label('arcticwolf.wd1', 'ATS-workday', 7, [ARCTIC_WOLF_TENANT]),
    label('Arctic Wolf Networks, Inc.', 'ATS-workday', 3, [ARCTIC_WOLF_TENANT]),
  ] });
  assert.equal(nameOf(result, 'Arctic Wolf Networks, Inc.'), 'Arctic Wolf');
  assert.equal(nameOf(result, 'arcticwolf.wd1'), 'Arctic Wolf');
  assert.ok(result.rules.some((rule) => rule.matchType === 'employer_url' && rule.matchKey === ARCTIC_WOLF_TENANT && rule.standardName === 'Arctic Wolf'));
});

test('the same posting under two related spellings joins them', () => {
  const result = plan({
    labels: [label('Progleasing', 'ATS-workday', 3), label('Progressive Leasing', 'Himalayas', 2)],
    postings: [posting('Progleasing', 'Progressive Leasing')],
  });
  assert.equal(nameOf(result, 'Progleasing'), 'Progressive Leasing');
});

test('related names without evidence stay apart', () => {
  const result = plan({ labels: [label('Spectrum', 'LinkedIn (Apify)', 2), label('Spectrum Brands, Inc', 'LinkedIn (Apify)', 4)] });
  assert.equal(nameOf(result, 'Spectrum'), undefined);
  assert.equal(nameOf(result, 'Spectrum Brands, Inc'), undefined);
});

test('identical postings never join unrelated names: reposters and subsidiaries', () => {
  const result = plan({
    labels: [label('U.S. Bank', 'careerforce'), label('Elavon, Inc.', 'ATS-workday'), label('Reebok International, Ltd', 'ATS-workable'), label('vmysmartpros', 'JSearch')],
    postings: [posting('U.S. Bank', 'Elavon, Inc.'), posting('Reebok International, Ltd', 'vmysmartpros')],
  });
  assert.deepEqual(result.groups.filter((group) => group.labels.length > 1), []);
  assert.equal(result.refused.filter((refusal) => refusal.reason === 'names_unrelated').length, 2);
});

test('a short shared name needs a site or two postings', () => {
  const once = plan({
    labels: [label('Eco Battery', 'Adzuna'), label('Eco Capital Inc', 'JSearch')],
    postings: [posting('Eco Battery', 'Eco Capital Inc')],
  });
  assert.equal(nameOf(once, 'Eco Battery'), undefined);
  assert.equal(once.refused[0].reason, 'needs_more_evidence');
  const twice = plan({
    labels: [label('GE', 'JSearch'), label('GE HealthCare', 'Adzuna', 4)],
    postings: [posting('GE', 'GE HealthCare', 'one'), posting('GE', 'GE HealthCare', 'two')],
  });
  assert.equal(nameOf(twice, 'GE'), 'GE HealthCare');
});

test('Joseph\'s names are walls no evidence crosses', () => {
  const result = plan({
    labels: [label('Spectrum', 'LinkedIn (Apify)', 2), label('Spectrum Brands, Inc', 'LinkedIn (Apify)', 4)],
    postings: [posting('Spectrum', 'Spectrum Brands, Inc')],
    pins: [{ key: 'spectrum', name: 'Spectrum' }, { key: 'spectrumbrands', name: 'Spectrum Brands' }],
  });
  assert.ok(!result.groups.some((group) => group.labels.includes('Spectrum') && group.labels.includes('Spectrum Brands, Inc')));
  assert.notEqual(nameOf(result, 'Spectrum'), 'Spectrum Brands');
  assert.notEqual(nameOf(result, 'Spectrum Brands, Inc'), 'Spectrum');
  assert.ok(result.refused.some((refusal) => refusal.reason === 'pinned_apart'));
});

test('an exact spelling Joseph separated keeps its own name even when it cleans up like another', () => {
  const result = plan({
    labels: [label('Flex', 'LinkedIn (Apify)', 5), label('flex', 'ATS-lever', 2), label('The Flex Company', 'Himalayas', 1)],
    labelPins: [{ label: 'The Flex Company', name: 'The Flex Company' }],
  });
  const flex = result.groups.find((group) => group.labels.includes('Flex'));
  assert.ok(flex && !flex.labels.includes('The Flex Company'));
});

test('a chain of links cannot drift to an employer the group name does not relate to', () => {
  const result = plan({
    labels: [
      label('Alpha Beta', 'LinkedIn (Apify)', 9),
      label('Alpha Beta Gamma', 'Adzuna', 2),
      label('Gamma Delta', 'JSearch', 1),
    ],
    postings: [posting('Alpha Beta', 'Alpha Beta Gamma'), posting('Alpha Beta Gamma', 'Gamma Delta')],
  });
  assert.equal(nameOf(result, 'Alpha Beta Gamma'), 'Alpha Beta');
  assert.notEqual(nameOf(result, 'Gamma Delta'), 'Alpha Beta');
  assert.ok(result.refused.some((refusal) => refusal.reason === 'not_related_to_group_name' && refusal.left === 'Gamma Delta'));
});

test('a tenant shared by several employers names none of them', () => {
  const vf = 'workday:vf.wd5.myworkdayjobs.com';
  const result = plan({ labels: [
    label('VF Outdoor, LLC', 'ATS-workday', 2, [vf]),
    label('VF Corporation', 'careerforce', 3, [vf]),
    label('Timberland', 'ATS-workday', 2, [vf]),
  ] });
  assert.equal(nameOf(result, 'VF Outdoor, LLC'), 'VF');
  assert.equal(nameOf(result, 'Timberland'), undefined);
  assert.ok(!result.rules.some((rule) => rule.matchType === 'employer_url' && rule.matchKey === vf));
});

test('the group name is the public brand, not a legal entity or a tenant slug', () => {
  const kraft = plan({ labels: [
    label('heinz.wd1', 'ATS-workday', 4, ['workday:heinz.wd1.myworkdayjobs.com']),
    label('U001 Kraft Heinz Food Company Company', 'ATS-workday', 3, ['workday:heinz.wd1.myworkdayjobs.com']),
    label('The Kraft Heinz Company', 'Himalayas', 2),
    label('Kraft Heinz', 'LinkedIn (Apify)', 1),
  ], postings: [posting('The Kraft Heinz Company', 'U001 Kraft Heinz Food Company Company')] });
  assert.equal(nameOf(kraft, 'heinz.wd1'), 'Kraft Heinz');
  const fortrea = plan({ labels: [
    label('fortrea.wd1', 'ATS-workday', 2, ['workday:fortrea.wd1.myworkdayjobs.com']),
    label('FTINC Fortrea Inc.', 'ATS-workday', 2, ['workday:fortrea.wd1.myworkdayjobs.com']),
  ] });
  assert.equal(nameOf(fortrea, 'fortrea.wd1'), 'Fortrea');
  const vernova = plan({ labels: [label('GE Vernova', 'LinkedIn (Apify)', 3), label('Gevernova', 'Adzuna', 1)] });
  assert.equal(nameOf(vernova, 'Gevernova'), 'GE Vernova');
});

test('keys Joseph named himself get no learned rule', () => {
  const result = plan({
    labels: [label('Prudential', 'LinkedIn (Apify)'), label('Prudential Financial', 'Adzuna')],
    pins: [{ key: 'prudential', name: 'Prudential Financial' }, { key: 'prudentialfinancial', name: 'Prudential Financial' }],
    manualKeys: new Set(['prudential']),
  });
  assert.equal(nameOf(result, 'Prudential'), undefined);
  assert.equal(nameOf(result, 'Prudential Financial'), 'Prudential Financial');
});
