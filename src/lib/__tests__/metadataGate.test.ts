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
