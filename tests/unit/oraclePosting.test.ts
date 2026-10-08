import assert from 'node:assert/strict';
import test from 'node:test';

import { oraclePostingDetailUrl, parseOraclePostingDetail } from '../../src/lib/oraclePosting';
import { evaluateAuthoritativeMetadata } from '../../src/lib/authoritativeMetadataGate';
import { localTriageVerdict } from '../../src/lib/localTriage';

const URL = 'https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19195/';
// Public Resideo response verified for job 19195: no LegalEmployer, a broad
// PrimaryLocation, and the actual Melville address under workLocation.
const posting = {
  Id: '19195',
  Title: 'District Sales Manager- New York',
  LegalEmployer: null,
  PrimaryLocation: 'United States',
  WorkplaceType: 'Remote',
  WorkplaceTypeCode: 'ORA_REMOTE',
  workLocation: [{ TownOrCity: 'Melville', Region2: 'NY', Country: 'US' }],
  otherWorkLocations: [],
  secondaryLocations: [],
  ExternalDescriptionStr: '<p>Drive demand for Resideo products.</p>',
  ExternalResponsibilitiesStr: '<p>Educate contractors and distributors.</p>',
  ExternalQualificationsStr: '<p>Five years of outside sales experience.</p>',
  CorporateDescriptionStr: '<p>Resideo develops connected home products.</p>',
};
const html = '<meta property="og:site_name" content="Resideo">';

test('Oracle refresh recovers employer, specific work location and remote arrangement from the Resideo response', () => {
  const result = parseOraclePostingDetail({ items: [posting] }, URL, html);
  assert.equal(result?.company, 'Resideo');
  assert.equal(result?.title, 'District Sales Manager- New York');
  assert.equal(result?.location, 'Melville, NY (Remote)');
  assert.match(result?.text || '', /Drive demand/);
  assert.match(result?.text || '', /Educate contractors/);
  assert.match(result?.text || '', /Five years/);
  assert.match(result?.text || '', /connected home/);
  assert.doesNotMatch(result?.text || '', /<p>/);
});

test('Oracle detail requests stay on the posting host and include both posting and site identity', () => {
  const result = oraclePostingDetailUrl(URL)!;
  assert.equal(result.origin, 'https://ehtl.fa.us6.oraclecloud.com');
  assert.equal(result.pathname, '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails');
  assert.equal(result.searchParams.get('finder'), 'ById;Id="19195",siteNumber=CX');
  assert.equal(oraclePostingDetailUrl('https://oraclecloud.com.evil.test/hcmUI/CandidateExperience/en/sites/CX/job/19195'), null);
  assert.equal(oraclePostingDetailUrl('https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs'), null);
});

test('Oracle metadata is never taken from another returned posting', () => {
  assert.equal(parseOraclePostingDetail({ items: [{ ...posting, Id: '19196' }] }, URL, html), null);
  assert.equal(parseOraclePostingDetail({ items: [] }, URL, html), null);
  assert.equal(parseOraclePostingDetail(null, URL, html), null);
});

test('missing employer evidence leaves the stored company available instead of guessing from an Oracle tenant', () => {
  const result = parseOraclePostingDetail({ items: [posting] }, URL);
  assert.equal(result?.company, undefined);
  assert.equal(parseOraclePostingDetail({ items: [posting] }, URL, '<meta property="og:site_name" content="Candidate Experience">')?.company, undefined);
  assert.equal(parseOraclePostingDetail({ items: [{ ...posting, LegalEmployer: 'Resideo Technologies' }] }, URL, html)?.company, 'Resideo Technologies');
});

test('multiple work addresses remain visible and missing addresses fall back to published locations', () => {
  const result = parseOraclePostingDetail({ items: [{
    ...posting,
    workLocation: [...posting.workLocation, ...posting.workLocation],
    otherWorkLocations: [{ TownOrCity: 'Boston', Region2: 'MA', Country: 'US' }],
  }] }, URL, html);
  assert.equal(result?.location, 'Melville, NY; Boston, MA (Remote)');
  const fallback = parseOraclePostingDetail({ items: [{
    ...posting,
    workLocation: [],
    PrimaryLocation: 'Paris, France',
    secondaryLocations: [{ Name: 'Lyon, France' }],
    WorkplaceType: 'Hybrid',
    WorkplaceTypeCode: 'ORA_HYBRID',
  }] }, URL, html);
  assert.equal(fallback?.location, 'Paris, France; Lyon, France (Hybrid)');
});

// Public AutoZone responses have no populated work address and include a US
// country search node in secondaryLocations beside the specific store city.
for (const [id, city] of [
  ['161839', 'Memphis, TN, United States'],
  ['158606', 'Costa Mesa, CA, United States'],
]) {
  test(`Oracle country search metadata cannot admit the nonlocal store in ${city}`, () => {
    const url = `https://egud.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/${id}/`;
    const result = parseOraclePostingDetail({ items: [{
      ...posting,
      Id: id,
      Title: 'Part Sales Manager – Full Time',
      PrimaryLocation: city,
      workLocation: [{ TownOrCity: null, Region2: null, Country: null }],
      secondaryLocations: [{ Name: 'United States', CountryCode: 'US' }],
      WorkplaceType: '',
      WorkplaceTypeCode: null,
    }] }, url, '<meta property="og:site_name" content="AutoZone">');
    assert.equal(result?.location, city);
    const metadata = { title: result?.title, company: result?.company, location: result?.location, url };
    const gate = evaluateAuthoritativeMetadata(metadata);
    assert.equal(gate.passes, false);
    assert.match(gate.reason, /outside the searched geographies/i);
    assert.equal(localTriageVerdict({ ...metadata, capRationale: '' }).pass, false);
  });
}

function publishedLocation(primary: string, secondary: string[], workplace = '') {
  return parseOraclePostingDetail({ items: [{
    ...posting,
    workLocation: [],
    PrimaryLocation: primary,
    secondaryLocations: secondary.map((Name) => ({ Name })),
    WorkplaceType: workplace,
    WorkplaceTypeCode: null,
  }] }, URL, html)?.location;
}

test('Oracle preserves real alternate cities, including an eligible local work site', () => {
  const location = publishedLocation('Memphis, TN, United States', ['United States', 'Minneapolis, MN, United States']);
  assert.equal(location, 'Memphis, TN, United States; Minneapolis, MN, United States');
  assert.equal(localTriageVerdict({ location, capRationale: '' }).pass, true);
  const nonlocal = publishedLocation('Memphis, TN, United States', ['United States', 'Costa Mesa, CA, United States']);
  assert.equal(localTriageVerdict({ location: nonlocal, capRationale: '' }).pass, false);
});

test('Oracle uses specific secondary locations when the primary is a country search node', () => {
  for (const country of ['United States', 'United States of America', 'US', 'USA', 'U.S.']) {
    const location = publishedLocation(country, ['Memphis, TN, United States']);
    assert.equal(location, 'Memphis, TN, United States');
    assert.equal(localTriageVerdict({ location, capRationale: '' }).pass, false);
  }
});

test('Oracle country-only and missing locations retain their existing triage behavior', () => {
  assert.equal(publishedLocation('United States', ['United States']), 'United States');
  assert.equal(localTriageVerdict({ location: publishedLocation('United States', []), capRationale: '' }).pass, true);
  assert.equal(publishedLocation('', []), undefined);
});

test('Oracle retains explicit remote options and workplace arrangements after removing country search nodes', () => {
  const remote = publishedLocation('Memphis, TN, United States', ['United States'], 'Remote');
  assert.equal(remote, 'Memphis, TN, United States (Remote)');
  assert.equal(localTriageVerdict({ location: remote, capRationale: '' }).pass, false);
  const nationalRemote = publishedLocation('United States', ['United States'], 'Remote');
  assert.equal(nationalRemote, 'United States (Remote)');
  assert.equal(localTriageVerdict({ location: nationalRemote, capRationale: '' }).pass, true);
  const alternateRemote = publishedLocation('Memphis, TN, United States', ['United States', 'Remote - United States']);
  assert.equal(alternateRemote, 'Memphis, TN, United States; Remote - United States');
  assert.equal(localTriageVerdict({ location: alternateRemote, capRationale: '' }).pass, true);
  const hybrid = publishedLocation('Memphis, TN, United States', ['United States'], 'Hybrid');
  assert.equal(hybrid, 'Memphis, TN, United States (Hybrid)');
  assert.equal(localTriageVerdict({ location: hybrid, capRationale: '' }).pass, false);
});
