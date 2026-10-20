import assert from 'node:assert/strict';
import test from 'node:test';
import { planGreenhouseImportRepair } from '../../src/lib/greenhouseImportRepair';

const before = { title: 'Job App', company: 'Unknown Company', employer: 'Unknown Company', location: null,
  url: 'https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002', source: 'Manual Import',
  fitScore: 55, aimFitScore: 87, reqFitScore: 89, status: 'inbox', scoringStatus: 'scored', tailoringStaged: true };
const recovered = { ats: 'Greenhouse', atsSlug: 'censys', title: 'Channel Account Manager, Central', company: 'Censys',
  location: 'Remote - Central United States (Chicago, Dallas)', text: 'Responsibilities: Activate, enable and expand existing channel partners. Build partner account plans and support enterprise co-selling. Qualifications: Five years of channel management experience. '.repeat(8) };

test('explicit Censys repair replaces corrupt metadata and form text without changing scores or lifecycle', () => {
  const data = planGreenhouseImportRepair(before, recovered);
  assert.deepEqual(Object.keys(data).sort(), ['canonicalUrl', 'company', 'description', 'employer', 'identityFingerprint', 'location', 'manualAts', 'title', 'url']);
  const after = { ...before, ...data };
  assert.equal(after.title, recovered.title);
  assert.equal(after.company, 'Censys');
  assert.equal(after.employer, 'Censys');
  assert.equal(after.url, 'https://job-boards.greenhouse.io/censys/jobs/8756673002');
  assert.equal(after.description, recovered.text);
  for (const key of ['fitScore', 'aimFitScore', 'reqFitScore', 'status', 'scoringStatus', 'tailoringStaged'] as const) {
    assert.equal(after[key], before[key]);
  }
});

test('repair rejects unverifiable evidence and conflicting authored titles or employers', () => {
  for (const evidence of [null, { ...recovered, atsSlug: 'other' }, { ...recovered, company: '' }, { ...recovered, text: 'Loading...' }]) {
    assert.throws(() => planGreenhouseImportRepair(before, evidence), /could not be verified/);
  }
  for (const saved of [{ ...before, title: 'Different Job' }, { ...before, company: 'Other Employer' },
    { ...before, employer: 'Other Employer' }]) {
    assert.throws(() => planGreenhouseImportRepair(saved, recovered), /conflicts/);
  }
});
