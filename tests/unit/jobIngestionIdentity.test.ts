import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeUsaJobsDescription,
  generateFingerprint,
  ingestionSourceRunStatus,
  isLikelyDuplicatePosting,
} from '../../src/lib/jobIngestion';

const substantialDescription = 'Own a complex enterprise sales territory, build executive relationships, and manage a disciplined pipeline. '
  .repeat(5);

test('fingerprints preserve location as part of a posting identity', () => {
  const minneapolis = generateFingerprint('Enterprise Account Executive', 'Acme, Inc.');
  const chicago = generateFingerprint('Enterprise Account Executive', 'Acme Inc');
  const normalizedCompany = generateFingerprint('Enterprise Account Executive', 'Acme Corporation');

  assert.equal(minneapolis, chicago);
  assert.equal(minneapolis, normalizedCompany);
});

test('different source IDs from the same provider remain distinct requisitions', () => {
  assert.equal(isLikelyDuplicatePosting(
    {
      title: 'Account Executive',
      company: 'Acme',
      location: 'Minneapolis, MN',
      description: substantialDescription,
      canonicalUrl: 'https://acme.example/jobs/req-10001',
      source: 'ATS-greenhouse',
      sourceId: '10001',
    },
    {
      title: 'Account Executive',
      company: 'Acme',
      location: 'Minneapolis, MN',
      description: substantialDescription + ' version 2',
      canonicalUrl: 'https://acme.example/jobs/req-10002',
      source: 'ATS-greenhouse',
      sourceId: '10002',
    },
  ), false);
});

test('different requisition IDs on the same ATS host do not collapse across feeds', () => {
  assert.equal(isLikelyDuplicatePosting(
    {
      title: 'Regional Sales Manager',
      company: 'Acme',
      location: 'Remote / United States',
      description: substantialDescription,
      canonicalUrl: 'https://boards.example.com/jobs/440001',
      source: 'Feed A',
      sourceId: 'feed-a-1',
    },
    {
      title: 'Regional Sales Manager',
      company: 'Acme',
      location: 'Remote / United States',
      description: substantialDescription + ' variant B',
      canonicalUrl: 'https://boards.example.com/jobs/440002',
      source: 'Feed B',
      sourceId: 'feed-b-9',
    },
  ), false);
});

test('short path IDs and mixed-case job ID parameters remain distinct', () => {
  const common = {
    title: 'Sales Manager',
    company: 'Acme',
    location: 'Remote',
  };
  assert.equal(isLikelyDuplicatePosting(
    { ...common, description: substantialDescription, canonicalUrl: 'https://jobs.example.com/jobs/123', source: 'Feed A', sourceId: 'a' },
    { ...common, description: substantialDescription + ' 2', canonicalUrl: 'https://jobs.example.com/jobs/124', source: 'Feed B', sourceId: 'b' },
  ), false);
  assert.equal(isLikelyDuplicatePosting(
    { ...common, description: substantialDescription, canonicalUrl: 'https://jobs.example.com/apply?jobId=ABC-1', source: 'Feed A', sourceId: 'a' },
    { ...common, description: substantialDescription + ' 3', canonicalUrl: 'https://jobs.example.com/apply?job_id=ABC-2', source: 'Feed B', sourceId: 'b' },
  ), false);
});

test('stable URL or exact substantial description still protects genuine duplicates', () => {
  const base = {
    title: 'Account Director',
    company: 'Acme LLC',
    location: 'Minneapolis, MN',
    description: substantialDescription,
  };
  assert.equal(isLikelyDuplicatePosting(
    { ...base, canonicalUrl: 'https://acme.example/careers/jobs/123456', source: 'Feed A', sourceId: 'a' },
    { ...base, canonicalUrl: 'https://acme.example/careers/jobs/123456', source: 'Feed B', sourceId: 'b' },
  ), true);
  assert.equal(isLikelyDuplicatePosting(
    { ...base, url: 'https://feed-a.example/listing/a', source: 'Feed A', sourceId: 'a' },
    { ...base, url: 'https://feed-b.example/listing/b', source: 'Feed B', sourceId: 'b' },
  ), true);
});

test('matching descriptions do not collapse postings in distinct locations', () => {
  assert.equal(isLikelyDuplicatePosting(
    {
      title: 'Account Executive', company: 'Acme', location: 'Minneapolis, MN',
      description: substantialDescription, source: 'Feed A', sourceId: 'a',
    },
    {
      title: 'Account Executive', company: 'Acme', location: 'Chicago, IL',
      description: substantialDescription, source: 'Feed B', sourceId: 'b',
    },
  ), false);
});

test('USAJOBS composition retains summary, duties, qualifications, and requirements', () => {
  const result = composeUsaJobsDescription({
    JobSummary: '<p>Lead partner programs.</p>',
    MajorDuties: ['Build the territory.', 'Coach account teams.'],
    Qualifications: 'Three years of relevant experience.',
    Requirements: ['U.S. citizenship.', 'Background investigation.'],
  });

  assert.match(result, /Job Summary\nLead partner programs\./);
  assert.match(result, /Major Duties\nBuild the territory\.\nCoach account teams\./);
  assert.match(result, /Qualifications\nThree years of relevant experience\./);
  assert.match(result, /Requirements\nU\.S\. citizenship\.\nBackground investigation\./);
});

test('source telemetry distinguishes failed, partial, and successful runs', () => {
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 0, duplicates: 0, filtered: 0, errors: 1 }), 'failed');
  assert.equal(ingestionSourceRunStatus({ seen: 4, inserted: 2, duplicates: 1, filtered: 0, errors: 1 }), 'partial');
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 3, duplicates: 0, filtered: 0, errors: 1 }), 'partial');
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 0, duplicates: 0, filtered: 0, errors: 0 }), 'success');
});
