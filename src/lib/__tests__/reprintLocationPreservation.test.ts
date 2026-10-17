import assert from 'node:assert/strict';
import test from 'node:test';
import { isDirectAtsReprint } from '../jobIngestion';
import { locationsCompatibleForReprint } from '../reprintLocationCompatibility';
import { selectDirectAtsMatch, planDirectMatchEnrichment } from '../atsDirectMatch';

const title = 'Partner Account Manager';
const company = 'Example';
const description = 'Manage established partner accounts, deliver training, conduct quarterly business reviews, and improve platform adoption. '.repeat(20);
const directUrl = 'https://job-boards.greenhouse.io/example/jobs/123456';
const aggregatorUrl = 'https://himalayas.app/companies/example/jobs/partner-account-manager';

test('new canonical location matches do not broaden automatic historical reprint consolidation', () => {
  for (const [aggregatorLocation, postingLocation] of [
    ['Unknown Location', 'Minneapolis, MN'],
    ['Minneapolis, MN', 'Boston, MA; Minneapolis, MN'],
    ['Minneapolis, MN', 'Toronto, Canada; Minneapolis, MN'],
  ]) {
    const aggregate = { title, company, description, source: 'Himalayas',
      url: aggregatorUrl, canonicalUrl: null, location: aggregatorLocation };
    const direct = { title, company, description, source: 'ATS-greenhouse',
      url: directUrl, location: postingLocation };
    assert.equal(locationsCompatibleForReprint(aggregatorLocation, postingLocation), false);
    assert.equal(isDirectAtsReprint(aggregate, direct), false, `${aggregatorLocation} / ${postingLocation}`);
    assert.equal(isDirectAtsReprint(direct, aggregate), false, 'both arrival orders must retain the previous consolidation rule');
    const matched = selectDirectAtsMatch(aggregate, [direct]);
    assert.equal(matched?.url, directUrl, 'link recovery should still accept the verified posting');
    assert.deepEqual(planDirectMatchEnrichment(aggregate, {
      url: matched!.url, description: null, postingTitle: title, postingLocation,
      platform: 'greenhouse', slug: 'example', matchedVia: 'stored',
    }), { url: directUrl, canonicalUrl: directUrl });
  }
});

test('existing exact, national and missing-location reprint behavior is retained', () => {
  for (const [left, right, expected] of [
    ['Minneapolis, MN', 'Minneapolis, MN', true],
    ['USA', 'Remote, United States', true],
    [null, 'Remote, Canada', true],
    ['Remote / Worldwide', 'Remote, Canada', true],
    ['USA', 'Remote, Canada', false],
    ['Milwaukee, WI', 'Minneapolis, MN', false],
  ] as const) {
    assert.equal(locationsCompatibleForReprint(left, right), expected, `${left} / ${right}`);
  }
});
