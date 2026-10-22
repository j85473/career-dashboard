import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRipplingPosting, parseRipplingPosting, ripplingPostingIdentity } from '../ripplingPosting';
import type { safeExternalFetch } from '../safeExternalFetch';

const id = '7aa0e661-47d6-4bf7-92d5-d480d50129f4';
const url = `https://ats.rippling.com/pdq/jobs/${id}`;
const body = { uuid: id, url, name: 'Partner Manager', companyName: 'PDQ',
  workLocations: ['Remote (United States)'], description: { company: '<p>About PDQ.</p>', role: '<p>Enable partners.</p>' } };

test('Rippling refresh reads the authored title and employer from the exact posting API', () => {
  const posting = parseRipplingPosting(body, url);
  assert.equal(posting?.title, 'Partner Manager');
  assert.equal(posting?.company, 'PDQ');
  assert.equal(posting?.location, 'Remote (United States)');
  assert.equal(posting?.text, 'About PDQ.\n\nEnable partners.');
  assert.equal(posting?.atsSlug, 'pdq');
});

test('another tenant, requisition or malformed public URL cannot supply metadata', () => {
  assert.equal(parseRipplingPosting({ ...body, uuid: 'different' }, url), null);
  assert.equal(parseRipplingPosting({ ...body, url: url.replace('/pdq/', '/other/') }, url), null);
  for (const bad of [url.replace('.com/', '.com.evil.example/'), url.replace('https:', 'http:'), url.replace('pdq/jobs/', 'pdq/jobs/%2f'), 'https://ats.rippling.com/pdq/jobs']) {
    assert.equal(ripplingPostingIdentity(bad), null);
  }
});

test('the fetcher requests only the exact API posting and refuses redirected responses', async () => {
  const read = (async (target: string) => {
    assert.equal(target, `https://ats.rippling.com/api/v1/board/pdq/jobs/${id}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof safeExternalFetch;
  assert.equal((await fetchRipplingPosting(`${url}?ref=joe`, read))?.company, 'PDQ');
  const redirected = (async () => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, 'url', { value: 'https://other.example/jobs/123' });
    return response;
  }) as typeof safeExternalFetch;
  assert.equal(await fetchRipplingPosting(url, redirected), null);
});
