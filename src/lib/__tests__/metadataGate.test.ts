import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAuthoritativeMetadata,
  hasAuthoritativeMetadata,
} from '../authoritativeMetadataGate';

/**
 * Lane one of local scoring: the checks that run *before* JD recovery, for
 * sources whose metadata is authoritative on arrival.
 *
 * Lane two still runs after recovery, because for an aggregator the location
 * is a guess that resolving the description often corrects — rejecting early
 * there would discard good roles on bad data. A direct ATS board publishes the
 * posting's own location and title, so there is nothing to wait for.
 *
 * Both checks in lane one must therefore be description-independent, and the
 * lane must stay scoped to authoritative sources. Both are asserted below.
 */
const metadataGate = evaluateAuthoritativeMetadata;

test('the gate applies to ATS boards and Glassdoor, not to aggregators', () => {
  assert.equal(hasAuthoritativeMetadata('ATS-pinpoint'), true);
  assert.equal(hasAuthoritativeMetadata('ATS-greenhouse'), true);
  assert.equal(hasAuthoritativeMetadata('Glassdoor (RapidAPI)'), true);
  // CareerForce is Minnesota's state job board and reads location directly
  // off the search card, not an inferred field. ingestExternalJob writes it
  // lowercase, unlike the ATS-* sources, so the match must be case-insensitive.
  assert.equal(hasAuthoritativeMetadata('careerforce'), true);
  assert.equal(hasAuthoritativeMetadata('CareerForce'), true);
  // An aggregator infers location rather than stating it, so it keeps the
  // slower path where the JD can still correct the metadata. The recovery
  // route and the retroactive cleanup script share this predicate, so a
  // drift here would have one of them dismissing rows the pipeline would keep.
  assert.equal(hasAuthoritativeMetadata('Adzuna'), false);
  assert.equal(hasAuthoritativeMetadata('Himalayas'), false);
  assert.equal(hasAuthoritativeMetadata('TheMuse'), false);
  assert.equal(hasAuthoritativeMetadata('Indeed'), false);
  assert.equal(hasAuthoritativeMetadata('RemoteOK'), false);
  assert.equal(hasAuthoritativeMetadata(null), false);
});

test('a foreign ATS posting is rejected with no description at all', () => {
  const verdict = metadataGate({
    title: 'Account Executive',
    company: 'Acme Ltd',
    location: 'London, United Kingdom',
  });
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('an internship is rejected on title alone', () => {
  const verdict = metadataGate({
    title: 'Sales Internship',
    company: 'Acme',
    location: 'Minneapolis, MN',
  });
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /internship/i);
});

test('in-scope postings survive the gate even with no description', () => {
  for (const location of ['Minneapolis, MN', 'Remote', 'United States', '', null]) {
    const verdict = metadataGate({ title: 'Partner Manager', company: 'Acme', location });
    assert.equal(verdict.passes, true, `rejected for location ${JSON.stringify(location)}: ${verdict.reason}`);
  }
});

test('a multi-site posting that includes the metro is kept', () => {
  const verdict = metadataGate({
    title: 'Channel Account Manager',
    company: 'Acme',
    location: 'Austin, TX; London, UK; Minneapolis, MN',
  });
  assert.equal(verdict.passes, true, verdict.reason);
});

test('a Workday placeholder cannot conceal a foreign location encoded in its URL', () => {
  for (const url of [
    'https://example.wd3.myworkdayjobs.com/en-US/jobs/job/Remote-Sweden/Partner-Manager_R1',
    'https://example.wd5.myworkdayjobs.com/en-US/jobs/job/Tijuana-Mexico/Account-Executive_R2',
    'https://example.wd1.myworkdaysite.com/recruiting/jobs/job/Home-Based-Spain/Sales-Manager_R3',
  ]) {
    const verdict = metadataGate({
      title: 'Partner Manager',
      company: 'Acme',
      location: '2 Locations',
      url,
    });
    assert.equal(verdict.passes, false, url);
    assert.match(verdict.reason, /outside the searched geographies/i);
  }
});

test('a Workday placeholder cannot conceal a country absent from the name/code lists', () => {
  // Thailand is in neither INTERNATIONAL_LOCATION nor
  // INTERNATIONAL_COUNTRY_CODE (jobLocationPolicy.ts), so this only rejects
  // because the recovered URL fragment carries no confirmed US state
  // evidence — not because "Thailand" or "TH" is a recognized name. That is
  // the actual regression case for job 652565cc-ef46-40f6-9eeb-b2f8d234cb4d
  // (Goodyear "Key Account Executive", Pathumthani, Thailand), which passed
  // geography triage on 2026-08-12 while both its Workday locations were
  // foreign, and it is deliberately unfixed by adding Thailand to a list:
  // the next uncovered country would reopen the same hole.
  const verdict = metadataGate({
    title: 'Key Account Executive',
    company: 'Acme',
    location: '2 Locations',
    url: 'https://acme.wd1.myworkdayjobs.com/en-US/acmecareers/job/TH-Pathumthani-Non-Plant/Key-Account-Manager_JR1',
  });
  assert.equal(verdict.passes, false, verdict.reason);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('a Workday placeholder with a US URL remains unknown rather than falsely narrowed', () => {
  const verdict = metadataGate({
    title: 'Partner Manager',
    company: 'Acme',
    location: '2 Locations',
    url: 'https://example.wd3.myworkdayjobs.com/en-US/jobs/job/Youngstown-Ohio/Partner-Manager_R1',
  });
  assert.equal(verdict.passes, true, verdict.reason);
});
