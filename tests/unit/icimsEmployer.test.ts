import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { isPlaceholderEmployerName } from '../../src/lib/companyIdentity';

const board = 'https://distribution-alliancelaundry.icims.com/jobs/search?in_iframe=1';
const link = browserPostingLink('icims', board, '/jobs/12522/sales-manager/job', 'Sales Manager')!;
const duties = 'Lead a team of sales professionals and maintain customer relationships. '.repeat(6);

function parse(introduction: string, company = 'UNAVAILABLE', pageTitle = 'Sales Manager in Pittsburg, California | Careers at Distribution - Pittsburg, CA', url = link.url) {
  const description = `<h2>Overview</h2><p>${introduction}</p><p>${duties}</p>`;
  const html = `<title>${pageTitle}</title><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', url, title: link.title, hiringOrganization: { name: company }, description,
    jobLocationType: 'TELECOMMUTE', jobLocation: { address: { addressLocality: 'Pittsburg', addressRegion: 'CA', addressCountry: 'US' } },
  })}</script>`;
  return parseBrowserPosting('icims', board, link, [{ url: link.url, html, text: '' }]);
}

test('iCIMS recovers the named employer from its opening overview when structured data is unavailable', () => {
  const job = parse('Alliance Laundry Systems Distribution is a full-service commercial and industrial laundry equipment partner.');
  assert.equal(job?.company, 'Alliance Laundry Systems Distribution');
  assert.equal(job?.location, 'Remote; Pittsburg, CA, US');
  assert.equal(job?.url, link.url);
  assert.equal(job?.title, 'Sales Manager');
});

test('unavailable labels cannot identify an employer, while real names retain the word', () => {
  for (const name of ['UNAVAILABLE', 'Unavailable', 'unavailable', 'un-available']) assert.equal(isPlaceholderEmployerName(name), true);
  assert.equal(isPlaceholderEmployerName('Unavailable Technologies'), false);
  assert.equal(parse('Lead our sales team.')?.company, 'Unknown Company');
});

test('employer recovery preserves explicit identity and refuses customer mentions or another requisition', () => {
  assert.equal(parse('Alliance Laundry Systems Distribution is a full-service provider.', 'Actual Employer')?.company, 'Actual Employer');
  for (const introduction of ['Our client is a commercial laundry company.', 'The company is a commercial laundry company.',
    'Our brand is a trusted equipment supplier.', 'Example Inc is a client of our staffing agency.',
    'Lead our team. Alliance Laundry Systems Distribution is a full-service provider.']) {
    assert.equal(parse(introduction)?.company, 'Unknown Company');
  }
  assert.equal(parse('Alliance Laundry Systems Distribution is a full-service provider.', 'UNAVAILABLE', undefined,
    'https://distribution-alliancelaundry.icims.com/jobs/999/other/job'), null);
  assert.equal(parse('Lead our sales team.', 'UNAVAILABLE', 'Sales Manager at Example Inc | Careers')?.company, 'Example Inc');
});
