import assert from 'node:assert/strict';
import test from 'node:test';
import { dayforcePostingIdentity, dayforcePostingKey, resolveDayforceObservation } from '../dayforcePostingIdentity';
import { generatePostingIdentity, isLikelyDuplicatePosting } from '../jobIngestion';
import { urlPostingIdentity } from '../jobUrlReconciliation';

const pelican = 'https://jobs.dayforcehcm.com/en-US/pelican/CANDIDATEPORTAL/jobs/6689';
const amphenol = 'https://jobs.dayforcehcm.com/en-US/amphenol/interconnectproductscareers/jobs/6689';

test('Pelican and Amphenol posting 6689 never share an ingestion or pasted-link identity', () => {
  assert.notEqual(generatePostingIdentity({ url: pelican }), generatePostingIdentity({ url: amphenol }));
  assert.notEqual(urlPostingIdentity(pelican), urlPostingIdentity(amphenol));
  const original = { title: 'Account Manager', company: 'Same display label', description: 'x'.repeat(500), source: 'ATS-dayforce', sourceId: '6689' };
  assert.equal(isLikelyDuplicatePosting({ ...original, url: pelican }, { ...original, url: amphenol }), false);
});

test('Dayforce identities retain client and career site while ignoring locale and tracking', () => {
  assert.deepEqual(dayforcePostingIdentity(pelican), { host: 'dayforce:pelican:candidateportal', key: '6689' });
  assert.equal(dayforcePostingKey(pelican), dayforcePostingKey(pelican.replace('en-US', 'fr-CA') + '?utm_source=test'));
  assert.equal(dayforcePostingKey(pelican), dayforcePostingKey(pelican.replace('dayforcehcm.com', 'dayforce.com')));
  assert.notEqual(dayforcePostingKey(pelican), dayforcePostingKey(pelican.replace('CANDIDATEPORTAL', 'OTHERPORTAL')));
  assert.notEqual(dayforcePostingKey(pelican), dayforcePostingKey(pelican.replace('6689', '6690')));
  assert.equal(isLikelyDuplicatePosting({ url: pelican }, { url: pelican.replace('en-US', 'fr-CA') }), true);
  for (const id of ['1', '494', '6689']) {
    const url = pelican.replace('6689', id);
    assert.equal(urlPostingIdentity(url), generatePostingIdentity({ url }));
    assert.ok(urlPostingIdentity(url));
  }
});

test('a malformed Dayforce URL cannot fall back to a shared host plus number', () => {
  for (const url of [
    'https://jobs.dayforcehcm.com/jobs/6689',
    pelican + '/extra',
    pelican.replace('pelican', 'pelican%2Fother'),
    pelican.replace('6689', 'unknown'),
  ]) {
    assert.equal(dayforcePostingIdentity(url), null);
    assert.equal(generatePostingIdentity({ url }), null);
  }
});

test('the rediscovery fast path cannot suppress another employer using the same bare number', async () => {
  const historical = { id: 'historical', jobId: 'amphenol', url: amphenol, job: { url: amphenol, canonicalUrl: amphenol, status: 'applied', aimFitScore: 68 } };
  const before = structuredClone(historical);
  const find = async (id: string) => id === '6689' ? historical : null;
  assert.equal((await resolveDayforceObservation({ sourceId: '6689', find })).observation, null);
  const recovered = await resolveDayforceObservation({ sourceId: '6689', incomingUrl: pelican, find });
  assert.equal(recovered.observation, null);
  assert.equal(recovered.sourceId, 'dayforce-posting:dayforce:pelican:candidateportal|6689');
  assert.deepEqual(historical, before);
});

test('a scoped source observation attached to the wrong employer is recovered without mutating it', async () => {
  const key = 'pelican::en-US::pelican::CANDIDATEPORTAL::jobs::6689';
  const historical = { id: 'historical', jobId: 'amphenol', url: pelican, job: { url: amphenol, canonicalUrl: amphenol } };
  const find = async (id: string) => id === key ? historical : null;
  assert.equal((await resolveDayforceObservation({ sourceId: key, find })).observation, null);
  const recovered = await resolveDayforceObservation({ sourceId: key, incomingUrl: pelican, find });
  assert.equal(recovered.ignoredObservation, historical);
  assert.equal(recovered.observation, null);
  const rightful = { ...historical, id: 'recovered', jobId: 'pelican', job: { url: pelican, canonicalUrl: pelican } };
  const repeat = await resolveDayforceObservation({ sourceId: key, incomingUrl: pelican,
    find: async (id) => id === key ? historical : rightful });
  assert.equal(repeat.observation, rightful);
  await assert.rejects(resolveDayforceObservation({ sourceId: key, incomingUrl: pelican, find: async () => historical }), /recovery observation conflicts/);
});

test('correctly scoped rediscovery stays a duplicate and a board URL cannot enter through that fast path', async () => {
  const sourceId = 'pelican::en-US::pelican::CANDIDATEPORTAL::jobs::6689';
  const observation = { id: 'known', jobId: 'pelican', url: pelican, job: { url: pelican, canonicalUrl: pelican } };
  const find = async () => observation;
  assert.equal((await resolveDayforceObservation({ sourceId, find })).observation, observation);
  assert.equal((await resolveDayforceObservation({ sourceId, incomingUrl: pelican, find })).observation, observation);
  await assert.rejects(resolveDayforceObservation({ sourceId, incomingUrl: 'https://jobs.dayforcehcm.com/en-US/pelican/CANDIDATEPORTAL', find }), /complete employer, career site and posting URL/);
});
