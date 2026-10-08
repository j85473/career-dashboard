import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_OPTIONS, identifyAts } from '../../src/lib/atsUtils';
import { parseZohoRecruitPostingHtml, parseZohoRecruitPostingJson, zohoRecruitPostingIdentity, zohoRecruitPublicDetailUrl } from '../../src/lib/zohoRecruitPosting';

const url = 'https://thinkbridge.zohorecruit.in/jobs/Careers/40078000018949076';
const description = `<p>About thinkbridge: we build business systems for growing companies.</p>
  <h3>Responsibilities</h3><p>Grow client accounts, manage executive relationships, lead quarterly
  business reviews, and report the value delivered by each engagement. Partner with engineering
  leads to translate stakeholder needs into prioritized requirements. Coordinate escalations,
  delivery updates, adoption programs, and client communication.</p>
  <h3>Requirements</h3><p>Five years of customer relationship management or technical account
  management experience. Demonstrated success expanding accounts and leading business reviews
  with executives. Strong communication skills and the ability to turn satisfaction, adoption,
  and incident metrics into clear narratives and action items. Familiarity with CRM and ERP
  systems, APIs, integrations, incident management, and change communication.</p>
  <p>Keep travel &lt;10% and use {account plans}. Our team's work is client-facing.</p>`;
const job = { id: '40078000018949076', Posting_Title: 'Customer Success Lead', Job_Description: description,
  Remote_Job: true, City: null, State: null, Country: null, Publish: true };

function page(records: unknown[] = [job], options: { hidden?: boolean; doubleQuoted?: boolean } = {}) {
  // Zoho embeds JSON inside a JS string, including hex-encoded punctuation,
  // escaped forward slashes and JS identity escapes that JSON itself rejects.
  const quote = options.doubleQuoted ? '"' : "'";
  const literal = JSON.stringify(records).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/"/g, '\\x22').replace(/</g, '\\x3c').replace(/-/g, '\\-').replace(/\//g, '\\/');
  return `<html><body><p>Manage cookies. Share job. Apply now.</p><template>{{record.Posting_Title}}</template>
    <script>var jobs = JSON.parse(${quote}${literal}${quote});
    var meta = {"org_info":{"company_name":"think\\-bridge","hide_company_name":${options.hidden === true}}};
    throw new Error('This script must never execute');</script></body></html>`;
}

test('Zoho is recognized across regional hosts and unknown overrides, with explicit selections retained', () => {
  assert.ok(ATS_OPTIONS.includes('Zoho Recruit'));
  for (const domain of ['com', 'eu', 'in', 'com.au', 'com.cn', 'jp']) {
    for (const manualAts of [undefined, 'Unknown', 'Unknown ATS']) {
      assert.equal(identifyAts({ url: url.replace('.in/', `.${domain}/`), source: 'Himalayas', manualAts }), 'Zoho Recruit');
    }
  }
  assert.equal(identifyAts({ url, manualAts: 'Workday' }), 'Workday');
  assert.equal(identifyAts({ source: 'ATS-zohorecruit' }), 'Zoho Recruit');
  assert.equal(identifyAts({ source: 'ATS-zoho-recruit' }), 'Zoho Recruit');
  assert.equal(identifyAts({ url: url.replace('zohorecruit.in', 'zohorecruit.in.evil.example') }), 'Unknown');
  assert.equal(identifyAts({ url: `https://example.com/?next=${url}` }), 'Unknown');
});

test('Zoho extracts the full exact-posting JD without executing scripts or saving page controls', () => {
  for (const doubleQuoted of [false, true]) {
    const result = parseZohoRecruitPostingHtml(page([job], { doubleQuoted }), url);
    assert.equal(result?.ats, 'Zoho Recruit');
    assert.equal(result?.title, 'Customer Success Lead');
    assert.equal(result?.company, 'think-bridge');
    assert.equal(result?.location, undefined);
    assert.match(result!.text, /Five years of customer relationship management/);
    assert.match(result!.text, /travel <10%/);
    assert.match(result!.text, /\{account plans\}/);
    assert.match(result!.text, /Our team's work is client-facing/);
    assert.doesNotMatch(result!.text, /Manage cookies|Share job|Apply now|record\.Posting_Title|must never execute|<p>/);
  }
});

test('Zoho binds numeric string IDs to the requested posting and rejects ambiguous or unusable data', () => {
  assert.equal(parseZohoRecruitPostingHtml(page([{ ...job, id: '40078000018949077' }]), url), null);
  assert.equal(parseZohoRecruitPostingHtml(page([job, job]), url), null);
  assert.equal(parseZohoRecruitPostingHtml(page([{ ...job, Publish: false }]), url), null);
  assert.equal(parseZohoRecruitPostingHtml(page([{ ...job, Job_Description: 'Enable JavaScript. Sign in to apply.' }]), url), null);
  assert.equal(parseZohoRecruitPostingHtml('<script>var jobs = JSON.parse(\'malformed\');</script>', url), null);
  assert.equal(parseZohoRecruitPostingHtml(page(), url.replace('thinkbridge.zohorecruit.in', 'example.com')), null);
  assert.equal(zohoRecruitPostingIdentity('https://thinkbridge.zohorecruit.in/jobs/Careers'), null);
  assert.equal(zohoRecruitPostingIdentity(url + '/Customer-Success-Lead?source=CareerSite')?.id, job.id);
});

test('Zoho preserves grounded locations and honors hidden employer branding', () => {
  assert.equal(parseZohoRecruitPostingHtml(page([{ ...job, City: 'Austin', State: 'Texas', Country: 'United States' }]), url)?.location,
    'Remote, Austin, Texas, United States');
  assert.equal(parseZohoRecruitPostingHtml(page([{ ...job, Remote_Job: false, City: 'Austin' }]), url)?.location, 'Austin');
  assert.equal(parseZohoRecruitPostingHtml(page([job], { hidden: true }), url)?.company, undefined);
});

test('Zoho public API parsing requires a successful exact-posting response and no credentials', () => {
  assert.equal(zohoRecruitPublicDetailUrl(url),
    'https://thinkbridge.zohorecruit.in/recruit/v2/public/Job_Openings/40078000018949076?pagename=Careers');
  assert.equal(zohoRecruitPublicDetailUrl(url.replace('/Careers/', '/US%20Careers/')),
    'https://thinkbridge.zohorecruit.in/recruit/v2/public/Job_Openings/40078000018949076?pagename=US+Careers');
  assert.equal(parseZohoRecruitPostingJson({ code: 'success', data: [job] }, url)?.text,
    parseZohoRecruitPostingHtml(page(), url)?.text);
  assert.equal(parseZohoRecruitPostingJson({ code: 'error', data: [job] }, url), null);
  assert.equal(parseZohoRecruitPostingJson({ code: 'success', data: [{ ...job, id: 'wrong' }] }, url), null);
  assert.equal(parseZohoRecruitPostingJson({ code: 'success', data: [job, job] }, url), null);
  assert.equal(parseZohoRecruitPostingJson({ code: 'success', data: [{ ...job, Job_Description: 'Sign in to apply.' }] }, url), null);
  assert.equal(parseZohoRecruitPostingJson({ code: 'success', data: null }, url), null);
});
