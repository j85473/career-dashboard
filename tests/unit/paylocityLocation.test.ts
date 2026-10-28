import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserPosting, paylocityPublishedLocation } from '../../src/lib/browserAtsPosting';
import { evaluateAuthoritativeMetadata } from '../../src/lib/authoritativeMetadataGate';

test('Paylocity full-remote header remains remote when a department follows it', () => {
  const url = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1234567';
  const title = 'Client Success Executive';
  const html = `<div class="job-preview-header"><h2>Acme</h2><div class="job-preview-title">${title}</div><div class="preview-location">Fully Remote <span> • </span> Remote Worker - N/A</div></div><div class="job-preview-details">${'Help customers adopt the product and coordinate customer programs. '.repeat(10)}</div>`;
  const posting = parseBrowserPosting('paylocity', 'https://recruiting.paylocity.com/recruiting/jobs/All/acme', { id: '1234567', title, url }, [{ url, html, text: '' }]);
  assert.ok(posting);
  assert.equal(posting.location, 'Fully Remote; Remote Worker - N/A');
  assert.equal(evaluateAuthoritativeMetadata(posting).passes, true);
});

test('Paylocity full-remote normalization retains published site and territory text', () => {
  assert.equal(paylocityPublishedLocation('Fully Remote • NC Based, NC'), 'Fully Remote; NC Based, NC');
  assert.equal(paylocityPublishedLocation(' Fully Remote • Remote Worker - N/A • Sales '), 'Fully Remote; Remote Worker - N/A • Sales');
});

test('Paylocity hybrid and on-site headers never gain remote eligibility', () => {
  assert.equal(paylocityPublishedLocation('Hybrid • Charlotte, NC'), 'Hybrid • Charlotte, NC');
  assert.equal(paylocityPublishedLocation('On-site • Dallas, TX'), 'On-site • Dallas, TX');
  assert.equal(paylocityPublishedLocation('Minneapolis, MN • Sales'), 'Minneapolis, MN • Sales');
});
