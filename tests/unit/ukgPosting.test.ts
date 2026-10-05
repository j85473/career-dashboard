import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUkgPostingHtml, ukgPostingIdentity } from '../../src/lib/ukgPosting';
import { readManualImportPage } from '../../src/lib/manualImportPage';

const boardPath = '/dre1001dryg/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
const id = '14ce5fe4-5d06-404d-8583-07a8c01f5bdf';
const url = `https://recruiting2.ultipro.com${boardPath}/OpportunityDetail?opportunityId=${id}`;
// The posting that reproduced the failure: blank Knockout title/headline,
// authoritative JSON constructor data, and two copies of the employer logo.
const opportunity = {
  Id: id, Title: 'Distributor Account Manager',
  Description: '<p>At Dreyer&rsquo;s Grand Ice Cream, part of Froneri.</p><p>Manage distributor forecasts, trade investment and promotions.</p>',
  Locations: [{ LocalizedDescription: 'TX - Remote', Address: { City: null, State: { Name: 'Texas' }, Country: { Name: 'United States' } } }],
};
const logo = `<img data-automation="navbar-large-logo" src="${boardPath}/Styles/GetLargeHeaderLogo?brandId=example" alt="Dreyer&#x27;s Grand Ice Cream">`;
function page(data: object = opportunity, branding = logo) {
  return `<html><head><title data-bind="text: title()"></title></head><body>${branding}${branding}
    <h1><span data-automation="opportunity-title" data-bind="text: formattedTitle"></span></h1>
    <script>var opportunity = new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify(data)});</script>
    <p>Loading...</p></body></html>`;
}

test('UKG recovers the exact role, employer and location from the unrendered posting', () => {
  const result = parseUkgPostingHtml(page(), url);
  assert.equal(result?.title, 'Distributor Account Manager');
  assert.equal(result?.company, "Dreyer's Grand Ice Cream");
  assert.equal(result?.location, 'TX - Remote');
  assert.match(result!.text, /Manage distributor forecasts/);
  assert.doesNotMatch(result!.text, /Loading|CandidateOpportunityDetail|<p>/);
  assert.equal(result?.ats, 'UKG');
});

test('UKG metadata is available before a manual card is created, without title inference', async () => {
  const result = await readManualImportPage({ html: page(), url }, async () => { assert.fail('UKG already supplies the posting identity'); });
  assert.equal(result.title, opportunity.Title);
  assert.equal(result.company, "Dreyer's Grand Ice Cream");
  assert.equal(result.location, 'TX - Remote');
  assert.match(result.description, /Manage distributor forecasts/);
  const supplied = await readManualImportPage({ html: page(), url, title: 'Reviewed role', company: 'Reviewed employer' }, async () => { assert.fail(); });
  assert.equal(supplied.title, 'Reviewed role');
  assert.equal(supplied.company, 'Reviewed employer');
});

test('UKG refuses other opportunity IDs, other providers and ambiguous query parameters', () => {
  assert.equal(parseUkgPostingHtml(page({ ...opportunity, Id: '24ce5fe4-5d06-404d-8583-07a8c01f5bdf' }), url), null);
  assert.equal(parseUkgPostingHtml(page(), url.replace('recruiting2.ultipro.com', 'example.com')), null);
  assert.equal(ukgPostingIdentity(`${url}&opportunityId=${id}`), null);
  assert.equal(ukgPostingIdentity(url.split('?')[0]), null);
  assert.equal(ukgPostingIdentity(url.replace('OpportunityDetail', 'OpportunityApply')), null);
});

test('UKG never substitutes a parent mentioned in the JD or unrelated image branding', () => {
  for (const branding of ['', '<img alt="Other Employer">', logo.replace(boardPath, '/other/JobBoard/other'), logo.replace("Dreyer&#x27;s Grand Ice Cream", 'UKG')]) {
    assert.equal(parseUkgPostingHtml(page(opportunity, branding), url)?.company, undefined);
  }
  assert.equal(parseUkgPostingHtml(page(opportunity, `${logo}${logo.replace("Dreyer&#x27;s Grand Ice Cream", 'Different employer')}`), url)?.company, undefined);
});

test('UKG handles escaped strings and braces, malformed data, all location entries and missing descriptions', () => {
  const tricky = '<p>Use {forecasts} and say "quoted"; sample }); text.</p>';
  assert.match(parseUkgPostingHtml(page({ ...opportunity, Description: tricky }), url)!.text, /Use \{forecasts\} and say "quoted"; sample \}\); text/);
  assert.equal(parseUkgPostingHtml(page().replace('"Title":', 'badJSON:'), url), null);
  const result = parseUkgPostingHtml(page({ ...opportunity, Description: null, Locations: [
    { Address: { City: 'Austin', State: { Name: 'Texas' }, Country: { Name: 'United States' } } },
    opportunity.Locations[0], opportunity.Locations[0],
  ] }), url);
  assert.equal(result?.text, '');
  assert.equal(result?.location, 'Austin, Texas, United States; TX - Remote');
});
