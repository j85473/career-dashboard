import { auditIndexOrder, auditCheckpointComplete } from '../../../scripts/audit_ats_common_crawl';
import assert from 'node:assert/strict';
import test from 'node:test';
import { eightfoldBoardSlugFromUrl, parseEightfoldConfig, eightfoldSearchUrl, eightfoldPostingUrl, eightfoldLocation } from '../eightfoldBoard';
import { parseAtsListingPayload, atsListingPageSize } from '../atsAcquisition';
import { planAtsV2PageCompletion } from '../atsAcquisitionDispatcherV2';

test('Eightfold discovery extracts employer identities and rejects vendor and internal pages', () => {
  assert.equal(eightfoldBoardSlugFromUrl('https://kraftheinz.eightfold.ai/careers/job/123'), 'kraftheinz.eightfold.ai');
  assert.equal(eightfoldBoardSlugFromUrl('https://acme.eightfold-eu.ai/careers'), 'acme.eightfold-eu.ai');
  assert.equal(eightfoldBoardSlugFromUrl('https://kraftheinz.eightfold.ai/careers?domain=kraftheinz.com&pid=123'), 'kraftheinz.eightfold.ai');
  assert.equal(eightfoldBoardSlugFromUrl('https://app.eightfold.ai/careers?domain=acme.com'), 'app.eightfold.ai::acme.com');
  for (const url of ['https://app.eightfold.ai/careers', 'https://apidocs.eightfold.ai/careers', 'https://acme.eightfold.ai/careerhub/explore/jobs/123', 'https://acme.eightfold.ai.evil.com/careers', 'https://app.eightfold.ai/careers?domain=acme.com%3Fjunk']) {
    assert.equal(eightfoldBoardSlugFromUrl(url), null, url);
  }
});

test('Eightfold reads the published employer domain and brand, never guessing them from the slug', () => {
  const config = '<code id="pcsx-data">{&quot;domain&quot;:&quot;kraftheinz.com&quot;,&quot;configs&quot;:{&quot;pcsxConfig&quot;:{&quot;branding&quot;:{&quot;companyName&quot;:&quot;Kraft Heinz&quot;}}}}</code>';
  assert.deepEqual(parseEightfoldConfig(config), { domain: 'kraftheinz.com', company: 'Kraft Heinz' });
  assert.throws(() => parseEightfoldConfig(config, 'another.com'), /mismatch/);
  assert.throws(() => parseEightfoldConfig('<html>sign in</html>'), /missing/);
  const page = new URL(eightfoldSearchUrl('kraftheinz.eightfold.ai', 10, 'kraftheinz.com'));
  assert.equal(page.searchParams.get('domain'), 'kraftheinz.com');
  assert.equal(page.searchParams.get('start'), '10');
});

test('Eightfold preserves listing totals and refuses error envelopes or identity-free postings', () => {
  const feed = { status: 200, data: { count: 777, positions: [{ id: 1970324837547281, name: 'Manager, Sales Analytics' }] } };
  const parsed = parseAtsListingPayload('eightfold', feed);
  assert.equal(parsed.total, 777);
  assert.equal(parsed.jobs.length, 1);
  assert.equal(atsListingPageSize('eightfold'), 10);
  assert.throws(() => parseAtsListingPayload('eightfold', { status: 403, data: { count: 0, positions: [] } }), /schema/);
  assert.throws(() => parseAtsListingPayload('eightfold', { status: 200, data: { count: 1, positions: [{}] } }), /schema/);
});

test('Eightfold pagination cannot seal a ten-job first page or an unexpectedly short page before the total', () => {
  assert.equal(planAtsV2PageCompletion({ platform: 'eightfold', requestedOffset: 0, responseCount: 10, providerTotal: 777 }).listingComplete, false);
  const short = planAtsV2PageCompletion({ platform: 'eightfold', requestedOffset: 10, responseCount: 2, providerTotal: 777 });
  assert.equal(short.listingComplete, false);
  assert.ok(short.anomaly);
  assert.equal(planAtsV2PageCompletion({ platform: 'eightfold', requestedOffset: 770, responseCount: 7, providerTotal: 777 }).listingComplete, true);
});

test('Eightfold retains multi-location and remote evidence and uses public job URLs', () => {
  const job = { id: 123, locations: ['Minneapolis, MN, US', 'Chicago, IL, US'], workLocationOption: 'remote_local' };
  assert.equal(eightfoldLocation(job), 'Remote — Minneapolis, MN, US; Chicago, IL, US');
  assert.equal(eightfoldPostingUrl('kraftheinz.eightfold.ai', { ...job, publicUrl: 'https://jobs.kraftheinz.com/careers/job/123' }), 'https://jobs.kraftheinz.com/careers/job/123');
});


test('Eightfold starts at the newest bounded index without falsely completing historical coverage', () => {
  const indices = ['CC-MAIN-2024-01-index', 'CC-MAIN-2025-01-index', 'CC-MAIN-2026-34-index'];
  const order = auditIndexOrder('eightfold', indices);
  assert.deepEqual(order, [...indices].reverse());
  assert.deepEqual(auditIndexOrder('workday', indices), indices);
  assert.equal(auditCheckpointComplete({ indexId: order[1], completedThrough: indices[2] }, indices[2], order), false);
  assert.equal(auditCheckpointComplete({ indexId: order[2], completedThrough: indices[2] }, indices[2], order), true);
});
