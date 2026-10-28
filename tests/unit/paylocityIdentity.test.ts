import assert from 'node:assert/strict';
import test from 'node:test';
import { paylocityPostingId, resolvePaylocityObservation } from '../../src/lib/paylocityPostingIdentity';
import { generatePostingIdentity, isLikelyDuplicatePosting, isDirectAtsReprint } from '../../src/lib/jobIngestion';
import { urlPostingIdentity } from '../../src/lib/jobUrlReconciliation';
import { paylocityRecoveryClosed, paylocityRetryDelayMs } from '../../src/lib/paylocityRecovery';

const url = (id: string) => `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${id}`;
test('recovery honors rate limits and only treats the publisher closure page as terminal', () => {
  const closed = 'https://recruiting.paylocity.com/Recruiting/Jobs/JobNotFound';
  const text = "We're sorry, that job does not exist or is not currently active.";
  assert.equal(paylocityRecoveryClosed(closed, 'Job Not Found', text), true);
  assert.equal(paylocityRecoveryClosed('https://evil.test/Recruiting/Jobs/JobNotFound', 'Job Not Found', text), false);
  assert.equal(paylocityRecoveryClosed(closed, 'Verify you are human', text), false);
  assert.equal(paylocityRecoveryClosed(url('4217642'), 'Job Not Found', text), false);
  assert.equal(paylocityRetryDelayMs('90'), 90000);
  assert.equal(paylocityRetryDelayMs(null), 30000);
});
test('Paylocity identity uses the numeric posting, consistently across ingestion and URL edits', () => {
  assert.equal(paylocityPostingId(url('4217642') + '/?utm_source=test'), '4217642');
  const a = generatePostingIdentity({ url: url('4217642') });
  assert.ok(a);
  assert.equal(urlPostingIdentity(url('4217642')), a);
  assert.notEqual(a, generatePostingIdentity({ url: url('4217643') }));
  assert.equal(a, urlPostingIdentity(url('4217642').toLowerCase()));
  for (const path of ['Details', 'Details/nope', 'Details/0', 'Details/4217642/apply', 'All/abc']) {
    const bad = `https://recruiting.paylocity.com/Recruiting/Jobs/${path}`;
    assert.equal(paylocityPostingId(bad), null);
    assert.equal(urlPostingIdentity(bad), null);
    assert.equal(generatePostingIdentity({ url: bad }), null);
  }
  assert.equal(paylocityPostingId('https://evil.test/Recruiting/Jobs/Details/4217642'), null);
});
test('different Paylocity numbers never merge even with identical descriptions, employer and source IDs', () => {
  const a = { title: 'Sales Manager', company: 'Acme', location: 'MN', description: 'Long description '.repeat(100), source: 'ATS-paylocity', sourceId: 'bad-key', url: url('4217642') };
  const b = { ...a, url: url('4217643') };
  assert.equal(isLikelyDuplicatePosting(a, b), false);
  assert.equal(isDirectAtsReprint(a, { ...b, source: 'SerpApi' }), false);
  assert.equal(isLikelyDuplicatePosting(a, { ...b, url: a.url }), true);
  assert.equal(isLikelyDuplicatePosting(a, { ...b, title: 'Accountant', company: 'Other' }), false);
});
test('poisoned historical observations cannot suppress recovery, and retries find the recovered card', async () => {
  const legacy = { id: 'observation', jobId: 'wheeler', url: url('4217642'), job: { url: url('4338492'), canonicalUrl: url('4338492') } };
  const rows = new Map([['board:4217642', legacy]]);
  const input = { sourceId: 'board:4217642', incomingUrl: url('4217642'), find: async (key: string) => rows.get(key) || null };
  const result = await resolvePaylocityObservation(input);
  assert.equal(result.observation, null);
  assert.equal(result.ignoredObservation?.jobId, 'wheeler');
  assert.equal(result.sourceId, 'paylocity-posting:4217642');
  rows.set(result.sourceId, { ...legacy, jobId: 'recovered', job: { url: legacy.url, canonicalUrl: legacy.url } });
  assert.equal((await resolvePaylocityObservation(input)).observation?.jobId, 'recovered');
  await assert.rejects(resolvePaylocityObservation({ ...input, incomingUrl: url('9999999') }), /exact historical/);
  assert.equal((await resolvePaylocityObservation({ ...input, sourceId: 'new' })).observation, null);
  rows.set('valid', { ...legacy, job: { url: legacy.url, canonicalUrl: legacy.url } });
  assert.equal((await resolvePaylocityObservation({ ...input, sourceId: 'valid' })).ignoredObservation, null);
});
