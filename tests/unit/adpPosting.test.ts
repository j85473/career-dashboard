import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { adpClientFeaturesUrl, fetchAdpPosting, parseAdpClientCompany, parseAdpPosting } from '../../src/lib/adpPosting';
import type { safeExternalFetch } from '../../src/lib/safeExternalFetch';

const url = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=87997030-820d-4515-bec9-cf549d124af7&ccId=19000101_000001&jobId=739758&lang=en_US';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/adp/channel-sales-specialist.json', import.meta.url), 'utf8'));
const client = (...names: unknown[]) => ({ meta: { customFieldGroup: { stringFields: [
  { nameCode: { codeValue: 'ClientID' }, stringValue: 'cyberpsinc' },
  ...names.map(stringValue => ({ nameCode: { codeValue: 'ClientName' }, stringValue })),
] } } });
const response = (body: unknown, responseUrl?: string) => {
  const result = Response.json(body);
  if (responseUrl) Object.defineProperty(result, 'url', { value: responseUrl });
  return result;
};

test('ADP recovers the CyberPower employer from the same tenant when the JD has no About heading', async () => {
  const calls: string[] = [];
  const fetchPage: typeof safeExternalFetch = async input => {
    const endpoint = String(input);
    calls.push(endpoint);
    return response(endpoint.includes('client-features') ? client('Cyber Power Systems USA Inc') : fixture, endpoint);
  };
  const posting = (await fetchAdpPosting(url, fetchPage))!;
  assert.equal(posting.company, 'Cyber Power Systems USA Inc');
  assert.equal(posting.title, 'Channel Sales Specialist');
  assert.match(posting.text, /between CyberPower and its channel partners/);
  assert.match(posting.text, /Current driver/); // The full JD survives the employer lookup.
  assert.equal(posting.location, undefined); // Missing locations are not invented.
  assert.equal(calls.length, 2);
  const endpoint = new URL(calls[1]);
  assert.equal(endpoint.origin, 'https://workforcenow.adp.com');
  assert.equal(endpoint.pathname, '/mascsr/default/careercenter/public/events/staffing/client-features');
  assert.equal(endpoint.searchParams.get('cid'), new URL(url).searchParams.get('cid'));
  assert.equal(endpoint.searchParams.get('ccId'), '19000101_000001');
  assert.equal(endpoint.searchParams.get('jobId'), '739758');
  assert.equal(adpClientFeaturesUrl(url.replace('workforcenow.adp.com', 'other.example')), null);
});

test('ADP client metadata requires one explicit company name and never uses a token or hostname', () => {
  assert.equal(parseAdpClientCompany(client('Cyber Power Systems USA Inc')), 'Cyber Power Systems USA Inc');
  assert.equal(parseAdpClientCompany(client('CyberPower', 'CyberPower')), 'CyberPower');
  for (const body of [null, {}, client(), client(null), client(''), client('Unknown Company'), client('workforcenow.adp.com'), client('ADP'), client('Default Brand'), client('CyberPower', 'Other Employer')]) {
    assert.equal(parseAdpClientCompany(body), undefined);
  }
});

test('ADP retains the exact JD when optional company metadata fails or redirects', async () => {
  for (const failure of ['network', 'status', 'invalid-json', 'redirect', 'missing-name']) {
    const posting = (await fetchAdpPosting(url, async input => {
      if (!String(input).includes('client-features')) return response(fixture);
      if (failure === 'network') throw new Error('Timed out');
      if (failure === 'status') return new Response('', { status: 503 });
      if (failure === 'invalid-json') return new Response('invalid JSON');
      if (failure === 'redirect') return response(client('Wrong Employer'), 'https://other.example/client-features');
      return response(client());
    }))!;
    assert.equal(posting.title, 'Channel Sales Specialist', failure);
    assert.equal(posting.company, undefined, failure);
    assert.match(posting.text, /between CyberPower and its channel partners/, failure);
  }
});

test('ADP does not look up or attach a company to a different requisition', async () => {
  let calls = 0;
  assert.equal(await fetchAdpPosting(url.replace('739758', '999999'), async () => { calls += 1; return response(fixture); }), null);
  assert.equal(calls, 1);
});

test('a verified employer heading keeps precedence over tenant configuration', async () => {
  let calls = 0;
  const posting = (await fetchAdpPosting(url, async () => {
    calls += 1;
    return response({ ...fixture, requisitionDescription: '<h2>About Verified Employer</h2><p>At Verified Employer, we build products.</p>' });
  }))!;
  assert.equal(posting.company, 'Verified Employer');
  assert.equal(calls, 1);
});

test('ADP recognizes both published client-name fields while rejecting conflicts and ignoring empty aliases', () => {
  const fields = (names: Array<[string, string]>) => ({ meta: { customFieldGroup: {
    stringFields: names.map(([codeValue, stringValue]) => ({ nameCode: { codeValue }, stringValue })),
  } } });
  assert.equal(parseAdpClientCompany(fields([['CLIENT_NAME', 'Example Employer']])), 'Example Employer');
  assert.equal(parseAdpClientCompany(fields([['CLIENT_NAME', ''], ['ClientName', 'Example Employer']])), 'Example Employer');
  assert.equal(parseAdpClientCompany(fields([['CLIENT_NAME', 'Other Employer'], ['ClientName', 'Example Employer']])), undefined);
  assert.equal(parseAdpClientCompany(fields([['CLIENT_ID', 'Example Employer']])), undefined);
});

test('ADP authored employer sections survive editor paragraphs, inline formatting and blank lines', () => {
  for (const description of [
    '<p><span>ABOUT US</span></p><p>Example Employer is an education provider.</p><p>SUMMARY</p><p>Example Employer is seeking an account manager.</p>',
    '<p><strong>Company Overview:</strong></p><p>&nbsp;</p><p><br></p><p>Example Employer is a technology business. Our team builds useful products.</p>',
  ]) {
    const parsed = parseAdpPosting({ ...fixture, requisitionDescription: description }, url);
    assert.equal(parsed?.company, 'Example Employer');
    assert.equal(parsed?.title, fixture.requisitionTitle);
    assert.match(parsed!.text, /Example Employer/);
    assert.equal(parseAdpPosting({ ...fixture, requisitionDescription: description }, url.replace('739758', '999999')), null);
  }
});

test('ADP employer sections reject client mentions, unnamed subjects, conflicting companies and script-only evidence', () => {
  for (const description of [
    '<p>Our client Example Employer is hiring an account manager.</p>',
    '<p>About Us</p><p>Our client is seeking staff. Our team helps them hire.</p>',
    '<p>Company Overview</p><p>Our client Example Employer is seeking staff. Our team helps them hire.</p>',
    '<p>About Us</p><p>Example Employer is a client. Our team provides support.</p>',
    '<p>About Us</p><p>Example Employer is a client. We provide support.</p>',
    '<h2>About Example Employer</h2><p>At Example Employer, we build products.</p><h2>About Other Employer</h2><p>At Other Employer, we build products.</p>',
    '<script>var text="About Us Example Employer is hiring staff. Our team is growing.";</script>',
  ]) assert.equal(parseAdpPosting({ ...fixture, requisitionDescription: description }, url)?.company, undefined);
});
