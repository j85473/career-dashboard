import assert from 'node:assert/strict';
import test from 'node:test';
import { talentsConnectPage, fetchTalentsConnectPosting } from '../../src/lib/talentsConnectPosting';
import { readManualImportPage } from '../../src/lib/manualImportPage';
import { parsePostingReaderMetadata } from '../../src/lib/postingMetadata';
import { parseJsonLdPostingHtml } from '../../src/lib/atsApi';

const id = 'a7f8e316-b893-46bf-80e4-5f2178b8b4e9';
const base = `https://jobs.syntegon.com/en/offer/regional-sales-manager-medtech/${id}`;
const url = `${base}?trid=tracking&showApplicationForm=true`;
const title = 'Regional Sales Manager - MedTech';
const company = 'Syntegon Technology Services LLC';
const posting = { '@type': 'JobPosting', identifier: { value: id }, url: base, title,
  hiringOrganization: { name: company }, description: '<p>Manage sales among existing customers.</p>\\n<p>Qualifications and benefits.</p>',
  jobLocation: [{ address: { addressLocality: 'Brooklyn Park', addressCountry: 'DE' } }] };
const application = 'https://jobs.smartrecruiters.com/SYNTEGON/744000154406675-regional-sales-manager-medtech?oga=true';
function page(data = posting, link = application) {
  return `<title>${title} (Brooklyn Park) › Syntegon</title><script type="application/ld+json">${JSON.stringify(data)}</script>
    <aside>Filters Country All Germany United States Company All Other Employer Location All Dallas</aside>
    <div class="mainItemAjax"><section class="contentItemHeaderOffer" data-offer-id="${id}"><h1>${title}</h1></section>
    <nav class="c-buttonbox"><a href="${link}">Apply</a></nav></div>`;
}
const detail = { id: '744000154406675', name: title, company: { identifier: 'SYNTEGON', name: 'SYNTEGON' },
  location: { city: 'Brooklyn Park', fullLocation: 'Brooklyn Park, MN, United States', remote: true },
  jobAd: { sections: { companyDescription: { title: 'Company Description', text: '<p>Syntegon company introduction.</p>' },
    jobDescription: { title: 'Job Description', text: '<p>Manage sales and customer relationships.</p>' },
    qualifications: { title: 'Qualifications', text: '<p>Three years of experience.</p>' },
    additionalInformation: { title: 'Additional Information', text: '<p>Compensation and benefits.</p>' } } } };

test('tracking and application-form links bind the exact offer without accepting filter metadata', async () => {
  const parsed = talentsConnectPage(page(), url);
  assert.equal(parsed?.title, title);
  assert.equal(parsed?.company, company);
  assert.deepEqual(parsed?.application, { company: 'SYNTEGON', id: detail.id });
  assert.deepEqual(parsed?.cities, ['Brooklyn Park']);
  assert.doesNotMatch(parsed!.text, /\\n|Filters|Other Employer/);
  const imported = await readManualImportPage({ html: page(), url }, async () => assert.fail('The exact offer supplies its title and employer'));
  assert.equal(imported.title, title);
  assert.equal(imported.company, company);
  assert.equal(imported.location, undefined, 'Do not trust the frontend template country');
  assert.doesNotMatch(imported.description, /Filters|Dallas/);
});

test('the canonical application record supplies verified US geography and the remote arrangement', async () => {
  const result = await fetchTalentsConnectPosting(page(), url, async target => {
    assert.equal(String(target), `https://api.smartrecruiters.com/v1/companies/SYNTEGON/postings/${detail.id}`);
    return Response.json(detail);
  });
  assert.equal(result?.company, company);
  assert.equal(result?.location, 'Brooklyn Park, MN, United States (Remote)');
  assert.equal(result?.ats, 'SmartRecruiters');
  assert.match(result!.text, /Compensation and benefits/);
  assert.doesNotMatch(result!.text, /Filters|All|Other Employer|<p>/);
});

test('other offer IDs, competing application links and unknown URL selectors cannot identify this job', () => {
  for (const html of [page({ ...posting, identifier: { value: 'other' } }),
    page({ ...posting, url: base.replace(id, 'b49959fa-acc1-4733-8685-8e79e5c238d5') }),
    page().replace(`data-offer-id="${id}"`, 'data-offer-id="other"'),
    page().replace(`<h1>${title}`, '<h1>Other role'),
    page().replace('</nav>', `<a href="${application.replace(detail.id, '744000999999999')}">Apply elsewhere</a></nav>`),
    page(posting, application.replace('jobs.smartrecruiters.com', 'jobs.smartrecruiters.com.evil.example')),
  ]) assert.equal(talentsConnectPage(html, url), null);
  assert.equal(talentsConnectPage(page(), `${url}&jobId=other`), null);
});

test('the exact linked ID, employer tenant, title and city must agree before canonical metadata is used', async () => {
  for (const invalid of [{ ...detail, id: 'wrong' }, { ...detail, company: { identifier: 'OTHER', name: 'Other' } },
    { ...detail, name: 'Other role' }, { ...detail, location: { ...detail.location, city: 'Dallas' } }]) {
    assert.equal(await fetchTalentsConnectPosting(page(), url, async () => Response.json(invalid)), null);
  }
  assert.equal(await fetchTalentsConnectPosting(page(), url, async () => {
    const response = Response.json(detail);
    Object.defineProperty(response, 'url', { value: 'https://api.smartrecruiters.com/v1/companies/OTHER/postings/123' });
    return response;
  }), null);
});

test('reader filter facets and their All options never become employer or location evidence', () => {
  const markdown = `Title: ${title}\nURL Source: ${url}\nMarkdown Content:\nFilters\n### Company\n* All\n* Other Employer\n### Location\n* All\n* Dallas\n# ${title}\nCompany: ${company}\nLocation: Brooklyn Park, MN\nDescription\nManage sales.`;
  assert.deepEqual(parsePostingReaderMetadata(markdown, url), { company, location: 'Brooklyn Park, MN' });
  assert.deepEqual(parsePostingReaderMetadata(markdown.replace(`Company: ${company}`, 'Company: All').replace('Location: Brooklyn Park, MN', 'Location: All'), url), {});
});

test('even a query-free HTML fallback cannot turn the frontend country default into job geography', () => {
  const description = '<h2>Responsibilities</h2><p>Develop sales strategies and maintain customer relationships. Manage forecasts, sales opportunities and customer proposals.</p><h2>Qualifications</h2><p>Three years of capital equipment sales experience and a bachelor degree in business administration. Travel to meet customers and support the sales team.</p>'.repeat(4);
  for (const link of [base, url]) {
    const result = parseJsonLdPostingHtml(page({ ...posting, description }), link);
    assert.equal(result?.company, company);
    assert.equal(result?.title, title);
    assert.equal(result?.location, undefined);
    assert.doesNotMatch(result!.text, /Filters|Other Employer/);
  }
});
