import assert from 'node:assert/strict';
import test from 'node:test';

import { readManualImportPage } from '../../src/lib/manualImportPage';

const url = 'https://jobs.lever.co/jobgether/24294863-3df6-4d12-8cdf-89910e9106b1';

// Authored fields from the posting that reproduced the import failure. Lever
// supplies a JobPosting object without a url field on this exact posting page.
const jobgetherPosting = {
  '@context': 'http://schema.org',
  '@type': 'JobPosting',
  title: 'Channel Account Manager',
  hiringOrganization: { '@type': 'Organization', name: 'Jobgether' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'US' } },
};

function page(posting: object, pageTitle = 'Jobgether - Channel Account Manager') {
  return `<html><head><title>${pageTitle}</title><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><h2>Channel Account Manager</h2><p>This position is listed on behalf of a partner company.</p></body></html>`;
}

test('Jobgether manual imports use the authored name and role before any model or follow-up refresh', async () => {
  const result = await readManualImportPage({ html: page(jobgetherPosting), url }, async () => {
    assert.fail('The complete posting metadata must not require title inference');
  });
  assert.equal(result.company, 'Jobgether');
  assert.equal(result.title, 'Channel Account Manager');
  assert.equal(result.location, 'US');
  assert.match(result.description, /listed on behalf of a partner company/);
  assert.doesNotMatch(result.description, /hiringOrganization/);
});

test('a failed title inference cannot discard a company the posting explicitly names', async () => {
  const result = await readManualImportPage({
    html: page({ ...jobgetherPosting, title: undefined }), url,
  }, async () => { throw new Error('Model unavailable'); });
  assert.equal(result.company, 'Jobgether');
  assert.equal(result.title, 'Jobgether - Channel Account Manager');
});

test('explicitly supplied fields outrank posting metadata and are kept when the other field is missing', async () => {
  const supplied = await readManualImportPage({
    html: page(jobgetherPosting), url, title: 'Reviewed title', company: 'Reviewed company',
  }, async () => { assert.fail('Both fields are already known'); });
  assert.equal(supplied.title, 'Reviewed title');
  assert.equal(supplied.company, 'Reviewed company');

  const partial = await readManualImportPage({
    html: '<title>Role at Employer</title>', url, title: 'Reviewed title',
  }, async () => ({ title: 'Inferred title', company: 'Employer' }));
  assert.equal(partial.title, 'Reviewed title');
  assert.equal(partial.company, 'Employer');
});

test('title inference fills only missing fields and cannot replace a structured company name', async () => {
  const result = await readManualImportPage({
    html: page({ ...jobgetherPosting, title: undefined }), url,
  }, async () => ({ title: 'Channel Account Manager', company: 'jobs.lever.co' }));
  assert.equal(result.title, 'Channel Account Manager');
  assert.equal(result.company, 'Jobgether');
});

test('structured metadata for another posting cannot name the imported job', async () => {
  const result = await readManualImportPage({
    html: page({ ...jobgetherPosting, url: url.replace('24294863', '34294863'), hiringOrganization: { name: 'Other company' } }), url,
  }, async () => ({ title: 'Channel Account Manager', company: 'Jobgether' }));
  assert.equal(result.company, 'Jobgether');
  assert.equal(result.location, undefined);
});

test('pages without usable posting metadata retain the existing title inference and hostname fallback', async () => {
  const html = '<title>Employer - Account Manager</title><script type="application/ld+json">invalid json</script>';
  const inferred = await readManualImportPage({ html, url }, async () => ({ title: 'Account Manager', company: 'Employer' }));
  assert.equal(inferred.title, 'Account Manager');
  assert.equal(inferred.company, 'Employer');

  const fallback = await readManualImportPage({ html, url }, async () => { throw new Error('Model unavailable'); });
  assert.equal(fallback.title, 'Employer - Account Manager');
  assert.equal(fallback.company, 'jobs.lever.co');
});
