import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSymphonyPosting, parseSymphonyPosting } from '../symphonyPosting';
import { symphonyPostingIdentity, symphonyPostingRequest } from '../symphonyAtsBoard';
import { publicAtsTestFixtures } from './publicAtsFixtures';
import { completePostingMetadata, postingRefreshDescription } from '../postingMetadata';

const url = 'https://careers.deltek.com/job/23859428/partner-enablement-specialist-remote';
const duties = 'Lead partner enablement programs, develop scalable learning paths, and manage partner readiness. '.repeat(8);
const qualifications = 'Experience designing partner enablement programs and influencing cross-functional stakeholders. '.repeat(8);
const companySummary = 'As the recognized global standard for project-based businesses, Deltek delivers software and information solutions. '.repeat(8);
const fixture = () => ({ ...(publicAtsTestFixtures.symphony as { searchResults: { job: Record<string, unknown> }[] }).searchResults[0].job,
  description: `<div data-field="responsibilities"><span style="display: none">Hidden content</span>${duties}</div><div data-field="description">${companySummary}</div><div data-field="qualifications">${qualifications}</div><div data-field="compensation">The U.S. salary range is $54,000.00-$95,000.00.</div>` });

test('single-posting requests bind the public posting ID to the verified API organization', () => {
  assert.deepEqual(symphonyPostingIdentity(url), { slug: 'deltek', id: '23859428' });
  const api = new URL(symphonyPostingRequest(url)!);
  assert.equal(api.pathname, '/api/job/get');
  assert.equal(api.searchParams.get('id'), '23859428');
  assert.equal(api.searchParams.get('companyName'), 'companies/d78c5717-c840-461e-8f42-7e005f1a8068');
  assert.equal(symphonyPostingRequest('https://careers.deltek.com/'), null);
  assert.equal(symphonyPostingRequest('https://careers.deltek.com.evil.test/job/23859428'), null);
});

test('exact API descriptions include duties, qualifications and compensation with published remote scope', async () => {
  const result = parseSymphonyPosting(fixture(), url)!;
  assert.equal(result.title, 'Partner Enablement Specialist');
  assert.equal(result.company, 'Deltek');
  assert.equal(result.location, 'US (Remote)');
  assert.ok(result.text.includes('Responsibilities\n'));
  assert.ok(result.text.includes(duties.trim()));
  assert.ok(result.text.includes(qualifications.trim()));
  assert.ok(result.text.includes('$54,000.00-$95,000.00'));
  assert.ok(!result.text.includes('Hidden content'));
  let fallbackCalls = 0;
  assert.equal(await completePostingMetadata(result, async () => { fallbackCalls++; return null; }), result);
  assert.equal(fallbackCalls, 0);
});

test('a company-only description cannot replace the manually corrected JD', () => {
  assert.equal(parseSymphonyPosting({ ...fixture(), description: companySummary }, url), null);
  assert.equal(parseSymphonyPosting({ ...fixture(), description: `<div data-field="description">${companySummary}</div>` }, url), null);
  assert.equal(parseSymphonyPosting({ ...fixture(), description: `<div data-field="responsibilities">${duties}</div>` }, url), null);
  assert.deepEqual(postingRefreshDescription({ description: '', structuredSource: true,
    existingDescription: 'Joe’s manually corrected duties and qualifications', preserveScores: true,
    metadata: { company: 'Deltek', location: 'US (Remote)' } }),
  { description: 'Joe’s manually corrected duties and qualifications', verified: false });
});

test('another posting or employer cannot satisfy the requested detail', () => {
  for (const change of [{ id: 123, url: 'https://careers.deltek.com/job/123/other-role' }, { company_name: 'Other' }, { scout_orgid: 1 }, { ats_portalid: 'Other' }]) {
    assert.equal(parseSymphonyPosting({ ...fixture(), ...change }, url), null);
  }
});

test('the detail adapter fetches only the requested API job and returns no replacement on failures', async () => {
  let calls = 0;
  const result = await fetchSymphonyPosting(url, async target => {
    calls++;
    assert.equal(String(target), symphonyPostingRequest(url));
    return new Response(JSON.stringify(fixture()), { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(calls, 1);
  assert.equal(result?.location, 'US (Remote)');
  assert.equal(await fetchSymphonyPosting(url, async () => new Response('', { status: 503 })), null);
  assert.equal(await fetchSymphonyPosting(url, async () => new Response(JSON.stringify({ ...fixture(), description: companySummary }))), null);
});
