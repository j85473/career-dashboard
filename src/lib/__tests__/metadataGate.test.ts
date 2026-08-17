import assert from 'node:assert/strict';
import test from 'node:test';

import { passesPreFilter } from '../jobFiltering';
import { localTriageVerdict } from '../localTriage';
import { isStructuredAtsSource } from '../jobDescriptionQuality';

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
function metadataGate(job: { title: string; company: string; location: string | null; url?: string }) {
  const prefilter = passesPreFilter({
    title: job.title,
    company: job.company,
    description: '',
    location: job.location || '',
    url: job.url || '',
  });
  if (!prefilter.passes) return { passes: false, reason: prefilter.reason };
  const triage = localTriageVerdict({ capRationale: '', title: job.title, location: job.location });
  return triage.pass ? { passes: true, reason: '' } : { passes: false, reason: triage.reason };
}

test('the gate applies to ATS boards and Glassdoor, not to aggregators', () => {
  assert.equal(isStructuredAtsSource('ATS-pinpoint'), true);
  assert.equal(isStructuredAtsSource('ATS-greenhouse'), true);
  // An aggregator infers location rather than stating it, so it keeps the
  // slower path where the JD can still correct the metadata.
  assert.equal(isStructuredAtsSource('Adzuna'), false);
  assert.equal(isStructuredAtsSource('Himalayas'), false);
  assert.equal(isStructuredAtsSource('TheMuse'), false);
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
