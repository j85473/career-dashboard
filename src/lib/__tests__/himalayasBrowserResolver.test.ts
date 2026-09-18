import assert from 'node:assert/strict';
import test from 'node:test';

import { directAtsApplyUrls, pagePassedCloudflare, rotatingCandidateIds } from '../himalayasBrowserResolver';

test('only an Apply link to a supported employer ATS can become canonical', () => {
  assert.deepEqual(directAtsApplyUrls([
    { text: 'Apply', href: 'https://himalayas.app/signup/talent?redirect=job' },
    { text: 'Company site', href: 'https://example.com/' },
    { text: 'Apply now', href: 'https://jobs.lever.co/panopto/123' },
    { text: 'Apply now', href: 'javascript:alert(1)' },
  ]), ['https://jobs.lever.co/panopto/123']);
});

test('a Cloudflare challenge is not mistaken for a rendered listing', () => {
  assert.equal(pagePassedCloudflare('Performing security verification', 'Just a moment...'), false);
  assert.equal(pagePassedCloudflare('Short body', 'Real title'), false);
  assert.equal(pagePassedCloudflare('Full job description '.repeat(30), 'Account Executive | Himalayas'), true);
});

test('candidate batches rotate and wrap instead of starving older listings', () => {
  assert.deepEqual(rotatingCandidateIds(['a', 'b', 'c', 'd', 'e'], 0, 2), {
    ids: ['a', 'b'], nextCursor: 2,
  });
  assert.deepEqual(rotatingCandidateIds(['a', 'b', 'c', 'd', 'e'], 4, 3), {
    ids: ['e', 'a', 'b'], nextCursor: 2,
  });
  assert.deepEqual(rotatingCandidateIds(['a', 'b'], 99, 8), {
    ids: ['b', 'a'], nextCursor: 1,
  });
});
