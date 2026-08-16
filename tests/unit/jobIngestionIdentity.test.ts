import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCareerOneStopJobsUrl,
  buildUsaJobsSearchRequests,
  budgetedProviderAttempt,
  composeUsaJobsDescription,
  generateFingerprint,
  ingestionSourceRunStatus,
  isConservativeSyndicatedDuplicate,
  isLikelyDuplicatePosting,
  isPermanentSourceFailure,
  parseCareerOneStopJob,
  parseHimalayasJob,
  processDetailProviderResponse,
  providerGeoPlan,
  remoteFeedLocation,
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

test('fingerprints discard Workday hostname shards from company identity', () => {
  assert.equal(
    generateFingerprint('Business Development Manager', '3M'),
    generateFingerprint('Business Development Manager', '3m.wd1'),
  );
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

test('different strong requisitions remain separate across different hosts without descriptions', () => {
  const common = { title: 'Channel Sales Manager', company: 'Acme', location: 'Remote' };
  assert.equal(isLikelyDuplicatePosting(
    { ...common, canonicalUrl: 'https://jobs.acme.example/jobs/REQ-1001', source: 'ATS', sourceId: '1001' },
    { ...common, canonicalUrl: 'https://feed.example/jobs/REQ-2002', source: 'Feed', sourceId: '2002' },
  ), false);
});

test('same display labels without stable cross-source identity remain distinct', () => {
  const common = { title: 'Channel Sales Manager', company: 'Acme', location: 'Minneapolis, MN' };
  assert.equal(isLikelyDuplicatePosting(
    {
      ...common,
      description: '',
      url: 'https://feed-a.example/listing/channel-sales-manager',
      source: 'Feed A',
      sourceId: 'feed-a-1',
    },
    {
      ...common,
      description: '',
      url: 'https://feed-b.example/listing/channel-sales-manager',
      source: 'Feed B',
      sourceId: 'feed-b-9',
    },
  ), false);
});

test('cross-source Workday aliases collapse by stable posting identity', () => {
  const title = 'IATD Business Development Manager – Medical Device and Diagnostics';
  const description = 'Develop and execute a business growth strategy for medical device manufacturers. '.repeat(6);
  assert.equal(isLikelyDuplicatePosting(
    {
      title,
      company: '3M',
      location: 'Maplewood, MN',
      description,
      canonicalUrl: 'https://3m.wd1.myworkdayjobs.com/en-US/Search/job/US-Minnesota-Maplewood/IATD-Business-Development-Manager---Medical-Device-and-Diagnostics_R01169151',
      source: 'careerforce',
      sourceId: 'careerforce-3m-r01169151',
    },
    {
      title,
      company: '3m.wd1',
      location: 'US, Minnesota, Maplewood',
      description,
      canonicalUrl: 'https://3m.wd1.myworkdayjobs.com/en-US/search/job/US-Minnesota-Maplewood/IATD-Business-Development-Manager---Medical-Device-and-Diagnostics_R01169151',
      source: 'ATS-workday',
      sourceId: '/job/US-Minnesota-Maplewood/IATD-Business-Development-Manager---Medical-Device-and-Diagnostics_R01169151',
    },
  ), true);
});

test('distinct Workday requisitions in the same location remain separate', () => {
  const base = {
    title: 'Business Development Manager',
    company: '3M',
    location: 'Maplewood, MN',
    description: substantialDescription,
  };
  assert.equal(isLikelyDuplicatePosting(
    {
      ...base,
      canonicalUrl: 'https://3m.wd1.myworkdayjobs.com/en-US/Search/job/US-Minnesota-Maplewood/Business-Development-Manager_R01169151',
      source: 'Feed A',
      sourceId: 'a',
    },
    {
      ...base,
      description: `${substantialDescription} distinct requisition`,
      canonicalUrl: 'https://3m.wd1.myworkdayjobs.com/en-US/search/job/US-Minnesota-Maplewood/Business-Development-Manager_R01169999',
      source: 'Feed B',
      sourceId: 'b',
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

test('USAJOBS high-travel canary uses only the documented 76%-or-greater bucket', () => {
  assert.deepEqual(buildUsaJobsSearchRequests({
    keyword: 'channel sales',
    geoLane: 'minnesota',
    travelPercentage: '8',
  }), [{
    url: 'https://data.usajobs.gov/api/Search?Keyword=channel+sales&ResultsPerPage=100&Page=1&LocationName=Minnesota&TravelPercentage=8',
    remoteOnly: false,
  }]);

  const remote = buildUsaJobsSearchRequests({
    keyword: 'channel sales',
    geoLane: 'us_remote',
    travelPercentage: '8',
  });
  assert.match(remote[0].url, /RemoteIndicator=true/);
  assert.match(remote[0].url, /TravelPercentage=8/);
  assert.equal(remote[0].remoteOnly, true);
});

test('Himalayas parser uses guid, object restrictions, and millisecond pubDate', () => {
  const parsed = parseHimalayasJob({
    guid: 'himalayas-123',
    title: 'Channel Partner Manager',
    companyName: 'Acme',
    description: 'Build partner relationships.',
    applicationLink: 'https://example.test/apply',
    locationRestrictions: [{ alpha2: 'US', name: 'United States', slug: 'united-states' }],
    pubDate: 1786248000000,
  });
  assert.equal(parsed?.sourceId, 'himalayas-123');
  assert.equal(parsed?.location, 'United States');
  assert.equal((parsed?.postedAt as Date).toISOString(), '2026-08-09T04:00:00.000Z');
});

test('CareerOneStop V2 adapter uses documented identity, snippet, sort, and option', () => {
  assert.equal(
    buildCareerOneStopJobsUrl({ userId: 'user', keyword: 'channel manager', location: '55405', radius: '75', days: 3 }),
    'https://api.careeronestop.org/v2/jobsearch/user/channel%20manager/55405/75/acquisitiondate/DESC/0/100/3?enableJobDescriptionSnippet=true',
  );
  const parsed = parseCareerOneStopJob({
    JvId: 'COS-55',
    JobTitle: 'Regional Channel Manager',
    Company: 'Acme',
    DescriptionSnippet: 'Own a distributor territory.',
    AcquisitionDate: '2026-08-09T12:00:00Z',
    URL: 'https://example.test/job/COS-55',
    Location: 'Minneapolis, MN',
  });
  assert.equal(parsed?.sourceId, 'COS-55');
  assert.equal(parsed?.description, 'Own a distributor territory.');
  assert.equal(parsed?.location, 'Minneapolis, MN');
});

test('WWR location retains the posted region or remains explicitly unspecified', () => {
  assert.equal(remoteFeedLocation('USA Only'), 'Remote / USA Only');
  assert.equal(remoteFeedLocation(''), 'Remote / Location unspecified');
});

test('provider geography plans explicitly map every canonical lane', () => {
  assert.deepEqual(providerGeoPlan('SerpApi', 'msp_metro'), {
    lane: 'msp_metro', location: 'Minneapolis, Minnesota, United States', radius: '75', querySuffix: '', remoteOnly: false,
  });
  assert.deepEqual(providerGeoPlan('Indeed', 'minnesota'), {
    lane: 'minnesota', location: 'Minnesota', radius: '200', querySuffix: '', remoteOnly: false,
  });
  // Adzuna searches `what` against title and body, so a descriptive suffix is
  // matched literally: "channel sales Upper Midwest regional" returned 0 results
  // against the live API, while the same query without it returned 385 over the
  // same 500-mile radius. Every other provider keeps the suffix.
  assert.deepEqual(providerGeoPlan('Adzuna', 'upper_midwest'), {
    lane: 'upper_midwest', location: 'Minneapolis, MN', radius: '500', querySuffix: '', remoteOnly: false,
  });
  assert.deepEqual(providerGeoPlan('SerpApi', 'upper_midwest'), {
    lane: 'upper_midwest', location: 'Minneapolis, MN', radius: '500', querySuffix: 'Upper Midwest regional', remoteOnly: false,
  });
  assert.deepEqual(providerGeoPlan('JSearch', 'us_remote'), {
    lane: 'us_remote', location: 'United States', radius: '0', querySuffix: 'remote', remoteOnly: true,
  });
});

test('every provider attempt reserves budget before the real request', async () => {
  let reservations = 0;
  let requests = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await budgetedProviderAttempt(
      'Indeed Details',
      async () => { reservations++; },
      async () => { requests++; return attempt; },
    );
  }
  assert.equal(reservations, 3);
  assert.equal(requests, 3);
});

test('detail responses classify non-OK statuses and count 200-empty as request success', async () => {
  const response = (status: number, payload: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
  const successes: string[] = [];

  await assert.rejects(
    processDetailProviderResponse('Indeed Details', response(401, {}), () => null, (provider) => successes.push(provider)),
    /Indeed Details HTTP 401/,
  );
  await assert.rejects(
    processDetailProviderResponse('JSearch Details', response(404, {}), () => null, (provider) => successes.push(provider)),
    /JSearch Details HTTP 404/,
  );
  assert.equal(successes.length, 0);

  const description = await processDetailProviderResponse(
    'JSearch Details',
    response(200, { data: [] }),
    (payload) => (payload as { data?: Array<{ job_description?: string }> }).data?.[0]?.job_description,
    (provider) => successes.push(provider),
  );
  assert.equal(description, null);
  assert.deepEqual(successes, ['JSearch Details']);
});

test('source telemetry distinguishes failed, partial, and successful runs', () => {
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 0, duplicates: 0, filtered: 0, errors: 1 }), 'failed');
  assert.equal(ingestionSourceRunStatus({ seen: 4, inserted: 2, duplicates: 1, filtered: 0, errors: 1 }), 'partial');
  // Inserted outcomes without corresponding seen rows violate reconciliation.
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 3, duplicates: 0, filtered: 0, errors: 1 }), 'failed');
  assert.equal(ingestionSourceRunStatus({ seen: 4, inserted: 1, duplicates: 3, filtered: 0, errors: 0 }), 'success');
});

test('a run that did nothing is idle, not successful', () => {
  // This case previously returned 'success', which is how a source that had
  // stopped returning anything went unnoticed for a week.
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 0, duplicates: 0, filtered: 0, errors: 0 }), 'idle');
  // Seeing jobs and inserting none is still real work: they were duplicates.
  assert.equal(ingestionSourceRunStatus({ seen: 12, inserted: 0, duplicates: 12, filtered: 0, errors: 0 }), 'success');
});

test('paid-source circuit breaker recognizes unavailable endpoints and credentials', () => {
  assert.equal(isPermanentSourceFailure(new Error('HTTP 404')), true);
  assert.equal(isPermanentSourceFailure(new Error('All configured API keys were rate-limited or rejected')), true);
  assert.equal(isPermanentSourceFailure(new Error('HTTP 500')), false);
});

test('syndicated detection requires an aggregator, exact title, and exact substantial description', () => {
  const direct = { title: 'Channel Account Manager', company: 'Acme', description: substantialDescription };
  assert.equal(isConservativeSyndicatedDuplicate(
    direct,
    { ...direct, company: 'Jobgether' },
  ), true);
  assert.equal(isConservativeSyndicatedDuplicate(
    direct,
    { ...direct, title: 'Senior Channel Account Manager', company: 'Jobgether' },
  ), false);
  assert.equal(isConservativeSyndicatedDuplicate(
    direct,
    { ...direct, company: 'Jobgether', description: `${substantialDescription}changed` },
  ), false);
});
