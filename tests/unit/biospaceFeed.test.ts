import test from 'node:test';
import assert from 'node:assert/strict';
import { BioSpaceFeedError, bioSpaceRetryAfter, fetchBioSpaceFeed } from '../../src/lib/biospaceFeed';

const now = Date.parse('2026-10-21T16:00:00Z');
test('BioSpace retry instructions accept seconds or future HTTP dates', () => {
  assert.equal(bioSpaceRetryAfter('7200', now), 7_200_000);
  assert.equal(bioSpaceRetryAfter('Wed, 21 Oct 2026 20:00:00 GMT', now), 14_400_000);
  for (const value of [null, '', 'invalid', '0', '-1', 'Tue, 20 Oct 2026 16:00:00 GMT']) assert.equal(bioSpaceRetryAfter(value, now), undefined);
});
test('BioSpace exposes rate-limit duration to the circuit and never accepts a challenge as an empty feed', async () => {
  await assert.rejects(fetchBioSpaceFeed('sales', undefined, async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } })), error => error instanceof BioSpaceFeedError && error.retryAfterMs === 7_200_000);
  await assert.rejects(fetchBioSpaceFeed('sales', undefined, async () => new Response('<html>Challenge</html>')), /schema mismatch/);
  const xml = '<rss><channel><item><title>Sales Director</title></item></channel></rss>';
  assert.equal(await fetchBioSpaceFeed('sales & partners', undefined, async (url, init) => {
    assert.equal(new URL(url).searchParams.get('keywords'), 'sales & partners');
    assert.ok(init.signal);
    return new Response(xml);
  }), xml);
});
