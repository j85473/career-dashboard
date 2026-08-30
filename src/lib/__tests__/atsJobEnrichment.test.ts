import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATS_JOB_ENRICHMENT_KEY,
  ATS_JOB_ENRICHMENT_VERSION,
  enrichAtsListingJob,
  isAtsJobEnrichmentMarker,
  markAtsListingsWithoutDetail,
  readAtsJobEnrichmentMarker,
  type AtsJobEnrichmentDependencies,
} from '../atsJobEnrichment';

class TestAtsPlatformDeferredError extends Error {
  constructor(
    readonly platform: string,
    readonly retryAt?: Date,
  ) {
    super(`deferred ${platform}`);
    this.name = 'AtsPlatformDeferredError';
  }
}

type Harness = {
  dependencies: Partial<AtsJobEnrichmentDependencies>;
  urls: string[];
  reservations: string[];
  successes: string[];
  failures: Array<{ provider: string; error: unknown }>;
  platformFailurePolicies: Array<boolean | undefined>;
  started: number;
  responded: Array<{ status: number; respondedAt: Date }>;
  inputCallbacks: Pick<
    Parameters<typeof enrichAtsListingJob>[0],
    'onRequestStarted' | 'onResponseReceived'
  >;
};

type HarnessInput = {
  body?: unknown;
  status?: number;
  jsonLd?: {
    found: boolean;
    descriptionIsString: boolean;
    description: string | null;
    company: string | null;
    location: string | null;
  };
  reserve?: (source: string) => Promise<{ allowed: boolean; reason?: string; retryAt?: Date }>;
};

function responseWithFencedClone(
  body: string,
  status: number,
  responseFence: { held: boolean },
): Response {
  const response = new Response(body, { status });
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'clone', {
    value: () => {
      assert.equal(responseFence.held, true, 'detail validation escaped the response fence');
      return clone();
    },
  });
  return response;
}

function createHarness(input: HarnessInput = {}): Harness {
  const urls: string[] = [];
  const reservations: string[] = [];
  const successes: string[] = [];
  const failures: Array<{ provider: string; error: unknown }> = [];
  const responded: Array<{ status: number; respondedAt: Date }> = [];
  const platformFailurePolicies: Array<boolean | undefined> = [];
  const responseFence = { held: false };
  const status = input.status ?? 200;
  const body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {});
  let started = 0;

  const fetchResponse = async (request: string | URL | Request) => {
    urls.push(request instanceof Request ? request.url : String(request));
    return responseWithFencedClone(body, status, responseFence);
  };
  const dependencies: Partial<AtsJobEnrichmentDependencies> = {
    fetch: fetchResponse,
    safeExternalFetch: fetchResponse,
    fetchPlatformResponse: async (_platform, _signal, request, options) => {
      platformFailurePolicies.push(options?.recordPlatformFailures);
      responseFence.held = true;
      try {
        const response = await request();
        await options?.onResponse?.(response);
        return response;
      } finally {
        responseFence.held = false;
      }
    },
    reserveProviderBudgetForSource: async (source) => {
      reservations.push(source);
      return input.reserve ? input.reserve(source) : { allowed: true };
    },
    recordProviderSuccess: async (provider) => {
      successes.push(provider);
    },
    recordProviderFailure: async ({ provider, error }) => {
      failures.push({ provider, error });
      return null;
    },
    createDeferredError: (platform, retryAt) => new TestAtsPlatformDeferredError(platform, retryAt),
    parseJsonLdPage: async () => input.jsonLd ?? {
      found: false,
      descriptionIsString: false,
      description: null,
      company: null,
      location: null,
    },
    now: () => new Date('2026-08-27T17:00:00.000Z'),
  };

  return {
    dependencies,
    urls,
    reservations,
    successes,
    failures,
    platformFailurePolicies,
    get started() {
      return started;
    },
    responded,
    inputCallbacks: {
      onRequestStarted: async () => {
        started += 1;
      },
      onResponseReceived: async (received) => {
        responded.push(received);
      },
    },
  };
}

test('marker validation is versioned and read rejects malformed reserved payloads', () => {
  const marker = {
    version: ATS_JOB_ENRICHMENT_VERSION,
    status: 'enriched',
    platform: 'workable',
    detailSource: 'ATS-workable Details',
    attempted: true,
    completedAt: '2026-08-27T17:00:00.000Z',
    description: 'Lead channel partnerships.',
    company: null,
    location: null,
    compensation: null,
  } as const;
  assert.equal(isAtsJobEnrichmentMarker(marker), true);
  assert.deepEqual(readAtsJobEnrichmentMarker({ [ATS_JOB_ENRICHMENT_KEY]: marker }), marker);
  assert.equal(readAtsJobEnrichmentMarker({
    [ATS_JOB_ENRICHMENT_KEY]: { ...marker, version: 2 },
  }), null);
  assert.equal(readAtsJobEnrichmentMarker({
    [ATS_JOB_ENRICHMENT_KEY]: { ...marker, completedAt: 'not-a-date' },
  }), null);
  assert.equal(readAtsJobEnrichmentMarker({
    [ATS_JOB_ENRICHMENT_KEY]: { ...marker, status: 'not_needed', attempted: true },
  }), null);
});

test('a non-needed listing gets a cloned marker without spending or mutating provider payload', async () => {
  const inputJob = {
    shortcode: 'ABC123',
    description: '<p>Already complete</p>',
    nested: { provider: true },
    [ATS_JOB_ENRICHMENT_KEY]: { providerOwnedCollision: true },
  };
  const harness = createHarness();
  const result = await enrichAtsListingJob({
    platform: 'workable',
    slug: 'acme',
    job: inputJob,
    requestTimeoutMs: 10_000,
    ...harness.inputCallbacks,
  }, harness.dependencies);

  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'not_needed');
  assert.equal(marker.reason, 'description_already_present');
  assert.equal(marker.attempted, false);
  assert.deepEqual(harness.reservations, []);
  assert.deepEqual(harness.urls, []);
  assert.equal(harness.started, 0);
  assert.notEqual(result, inputJob);
  assert.notEqual(result.nested, inputJob.nested);
  assert.deepEqual(inputJob[ATS_JOB_ENRICHMENT_KEY], { providerOwnedCollision: true });
});

test('Breezy preserves explicit annual USD compensation even when description detail is not needed', async () => {
  const harness = createHarness();
  const result = await enrichAtsListingJob({
    platform: 'breezy',
    slug: 'acme',
    job: {
      description: 'Already present',
      salary: '$150,000 – $170,000 / year',
      url: 'https://acme.breezy.hr/p/channel-manager',
    },
    requestTimeoutMs: 10_000,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'not_needed');
  assert.equal(marker.compensation, '$150,000–$170,000 base');
  assert.deepEqual(harness.urls, []);
});

test('every detail adapter applies the immutable listing-title gate before a request', async () => {
  for (const fixture of [
    {
      platform: 'workday',
      slug: 'acme.wd5::Careers',
      job: { text: 'Registered Nurse, ICU', externalPath: '/job/REQ-1' },
    },
    {
      platform: 'smartrecruiters',
      slug: 'acme',
      job: { id: 'sr-1', name: 'Registered Nurse, ICU' },
    },
    {
      platform: 'workable',
      slug: 'acme',
      job: { shortcode: 'wk-1', title: 'Warehouse Associate' },
    },
    {
      platform: 'bamboohr',
      slug: 'acme',
      job: { id: 42, title: 'Registered Nurse, ICU' },
    },
    {
      platform: 'breezy',
      slug: 'acme',
      job: { title: 'Warehouse Associate', url: 'https://acme.breezy.hr/p/1' },
    },
    {
      platform: 'teamtailor',
      slug: 'acme',
      job: { title: 'Warehouse Associate', url: 'https://acme.teamtailor.com/jobs/1' },
    },
    {
      platform: 'rippling',
      slug: 'acme',
      job: { uuid: 'rp-1', name: 'Registered Nurse, ICU' },
    },
  ]) {
    const harness = createHarness();
    const result = await enrichAtsListingJob({
      ...fixture,
      requestTimeoutMs: 10_000,
    }, harness.dependencies);
    const marker = readAtsJobEnrichmentMarker(result);
    assert.ok(marker);
    assert.equal(marker.status, 'not_needed');
    assert.equal(marker.reason, 'title_gate_rejected');
    assert.deepEqual(harness.reservations, []);
    assert.deepEqual(harness.urls, []);
  }
});

test('bounded marker planning resolves every no-request item without touching detail-required jobs', () => {
  const inputJobs = [
    { id: 'sr-rejected', name: 'Registered Nurse, ICU' },
    { id: 'sr-needed', name: 'Channel Manager' },
    { id: 'sr-complete', name: 'Partner Manager', description: 'Already complete.' },
  ];
  const result = markAtsListingsWithoutDetail({
    platform: 'smartrecruiters',
    slug: 'acme',
    jobs: inputJobs,
  }, {
    now: () => new Date('2026-08-30T22:00:00.000Z'),
  });

  assert.equal(result.markedCount, 2);
  assert.equal(readAtsJobEnrichmentMarker(result.jobs[0])?.reason, 'title_gate_rejected');
  assert.equal(readAtsJobEnrichmentMarker(result.jobs[1]), null);
  assert.equal(
    readAtsJobEnrichmentMarker(result.jobs[2])?.reason,
    'description_already_present',
  );
  assert.deepEqual(result.jobs[1], inputJobs[1]);
  assert.equal(Object.hasOwn(inputJobs[0], ATS_JOB_ENRICHMENT_KEY), false);
  assert.equal(Object.hasOwn(inputJobs[2], ATS_JOB_ENRICHMENT_KEY), false);
});

test('all seven direct ATS adapters preserve URLs and parsed enrichment semantics', async (t) => {
  const fixtures: Array<{
    name: string;
    platform: string;
    slug: string;
    job: Record<string, unknown>;
    body: unknown;
    jsonLd?: HarnessInput['jsonLd'];
    expectedUrl: string;
    expected: Partial<{
      description: string | null;
      company: string | null;
      location: string | null;
      compensation: string | null;
    }>;
  }> = [
    {
      name: 'Workday',
      platform: 'workday',
      slug: 'acme.wd5::Careers',
      job: { text: 'Strategic Account Manager', externalPath: '/job/REQ-1' },
      body: {
        hiringOrganization: { name: 'Acme Systems' },
        jobPostingInfo: {
          jobDescription: '<p>Lead strategic accounts.</p>',
          location: 'Minneapolis, MN',
          additionalLocations: ['Chicago, IL'],
        },
      },
      expectedUrl: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/REQ-1',
      expected: {
        description: '<p>Lead strategic accounts.</p>',
        company: 'Acme Systems',
        location: 'Minneapolis, MN; Chicago, IL',
      },
    },
    {
      name: 'SmartRecruiters',
      platform: 'smartrecruiters',
      slug: 'acme',
      job: { id: 'sr-1', name: 'Channel Manager' },
      body: {
        jobAd: {
          sections: {
            companyDescription: { text: 'Marketing boilerplate' },
            jobDescription: { text: 'Own the channel.' },
            qualifications: { text: 'Five years experience.' },
            additionalInformation: { text: 'Travel required.' },
          },
        },
      },
      expectedUrl: 'https://api.smartrecruiters.com/v1/companies/acme/postings/sr-1',
      expected: { description: 'Own the channel.\n\nFive years experience.\n\nTravel required.' },
    },
    {
      name: 'Workable',
      platform: 'workable',
      slug: 'acme',
      job: { shortcode: 'WK-1', title: 'Partner Manager' },
      body: {
        description: 'Manage partners.',
        requirements: 'Build joint plans.',
        benefits: 'Health coverage.',
      },
      expectedUrl: 'https://apply.workable.com/api/v1/accounts/acme/jobs/WK-1',
      expected: { description: 'Manage partners.\n\nBuild joint plans.\n\nHealth coverage.' },
    },
    {
      name: 'BambooHR',
      platform: 'bamboohr',
      slug: 'acme',
      job: { id: 42, title: 'Account Manager' },
      body: { result: { jobOpening: { description: '<p>Grow accounts.</p>' } } },
      expectedUrl: 'https://acme.bamboohr.com/careers/42/detail',
      expected: { description: '<p>Grow accounts.</p>' },
    },
    {
      name: 'Breezy',
      platform: 'breezy',
      slug: 'acme',
      job: {
        friendly_id: 'br-1',
        title: 'Territory Manager',
        salary: '$120,000-$140,000 annual',
      },
      body: '<html>JobPosting</html>',
      jsonLd: {
        found: true,
        descriptionIsString: true,
        description: '<p>Lead a territory.</p>',
        company: 'Acme Incorporated',
        location: 'Minneapolis, MN',
      },
      expectedUrl: 'https://acme.breezy.hr/p/br-1',
      expected: {
        description: '<p>Lead a territory.</p>',
        company: 'Acme Incorporated',
        location: 'Minneapolis, MN',
        compensation: '$120,000–$140,000 base',
      },
    },
    {
      name: 'Teamtailor',
      platform: 'teamtailor',
      slug: 'acme',
      job: {
        title: 'Regional Sales Manager',
        content_html: '<p>Existing feed description.</p>',
        url: 'https://acme.teamtailor.com/jobs/tt-1',
      },
      body: '<html>JobPosting</html>',
      jsonLd: {
        found: true,
        descriptionIsString: true,
        description: '<p>Existing feed description.</p>',
        company: 'Acme',
        location: 'Chicago, IL',
      },
      expectedUrl: 'https://acme.teamtailor.com/jobs/tt-1',
      expected: { description: null, location: 'Chicago, IL' },
    },
    {
      name: 'Rippling',
      platform: 'rippling',
      slug: 'acme',
      job: { uuid: 'rp-1', name: 'Partner Manager' },
      body: {
        description: { company: 'About Acme.', role: 'Build partner growth.' },
        companyName: 'Acme Brands',
        workLocations: ['Remote - US', 'Minneapolis, MN'],
        payRangeDetails: [{
          currency: 'USD',
          frequency: 'YEAR',
          rangeStart: 130000,
          rangeEnd: 160000,
        }],
      },
      expectedUrl: 'https://ats.rippling.com/api/v1/board/acme/jobs/rp-1',
      expected: {
        description: 'About Acme.\n\nBuild partner growth.',
        company: 'Acme Brands',
        location: 'Remote - US; Minneapolis, MN',
        compensation: '$130,000–$160,000 base',
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const harness = createHarness({ body: fixture.body, jsonLd: fixture.jsonLd });
      const result = await enrichAtsListingJob({
        platform: fixture.platform,
        slug: fixture.slug,
        job: fixture.job,
        requestTimeoutMs: 10_000,
        ...harness.inputCallbacks,
      }, harness.dependencies);
      const marker = readAtsJobEnrichmentMarker(result);
      assert.ok(marker);
      assert.equal(marker.status, 'enriched');
      assert.equal(marker.attempted, true);
      assert.deepEqual(harness.urls, [fixture.expectedUrl]);
      assert.deepEqual(harness.reservations, [
        `ATS-${fixture.platform}`,
        `ATS-${fixture.platform} Details`,
      ]);
      assert.deepEqual(harness.successes, [`ATS-${fixture.platform} Details`]);
      assert.deepEqual(harness.failures, []);
      assert.equal(harness.started, 1);
      assert.deepEqual(harness.responded, [{
        status: 200,
        respondedAt: new Date('2026-08-27T17:00:00.000Z'),
      }]);
      for (const [field, expected] of Object.entries(fixture.expected)) {
        assert.equal(marker[field as keyof typeof marker], expected, field);
      }
      assert.equal(Object.hasOwn(fixture.job, ATS_JOB_ENRICHMENT_KEY), false);
    });
  }
});

test('BambooHR falls back to the outer description when jobOpening description is blank', async () => {
  const harness = createHarness({
    body: {
      result: {
        jobOpening: { description: '' },
        description: '<p>Grow partner accounts.</p>',
      },
    },
  });
  const result = await enrichAtsListingJob({
    platform: 'bamboohr',
    slug: 'acme',
    job: { id: 42, title: 'Account Manager' },
    requestTimeoutMs: 10_000,
    ...harness.inputCallbacks,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'enriched');
  assert.equal(marker.description, '<p>Grow partner accounts.</p>');
});

test('a base circuit refusal and 429 defer without writing a completion marker', async (t) => {
  await t.test('base circuit', async () => {
    const retryAt = new Date('2026-08-27T17:15:00.000Z');
    const harness = createHarness({
      reserve: async (source) => source === 'ATS-workable'
        ? { allowed: false, reason: 'circuit_open', retryAt }
        : { allowed: true },
    });
    await assert.rejects(
      enrichAtsListingJob({
        platform: 'workable',
        slug: 'acme',
        job: { shortcode: 'WK-1' },
        requestTimeoutMs: 10_000,
      }, harness.dependencies),
      (error: unknown) => error instanceof TestAtsPlatformDeferredError
        && error.platform === 'ATS-workable'
        && error.retryAt?.getTime() === retryAt.getTime(),
    );
    assert.deepEqual(harness.reservations, ['ATS-workable']);
    assert.deepEqual(harness.urls, []);
  });

  await t.test('HTTP 429', async () => {
    const harness = createHarness({ status: 429 });
    await assert.rejects(
      enrichAtsListingJob({
        platform: 'workable',
        slug: 'acme',
        job: { shortcode: 'WK-1' },
        requestTimeoutMs: 10_000,
        ...harness.inputCallbacks,
      }, harness.dependencies),
      (error: unknown) => error instanceof TestAtsPlatformDeferredError
        && error.platform === 'ATS-workable',
    );
    assert.equal(harness.started, 1);
    assert.deepEqual(harness.responded.map(({ status }) => status), [429]);
    assert.deepEqual(harness.successes, []);
    assert.deepEqual(harness.failures, []);
  });
});

test('an aborted enrichment defers before reserving or writing a marker', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort(new Error('worker stopping'));
  await assert.rejects(
    enrichAtsListingJob({
      platform: 'rippling',
      slug: 'acme',
      job: { uuid: 'rp-1' },
      signal: controller.signal,
      requestTimeoutMs: 10_000,
    }, harness.dependencies),
    (error: unknown) => error instanceof TestAtsPlatformDeferredError
      && error.platform === 'ATS-rippling',
  );
  assert.deepEqual(harness.reservations, []);
  assert.deepEqual(harness.urls, []);
});

test('a detail-specific circuit refusal defers the suffix without writing an unavailable marker', async () => {
  const harness = createHarness({
    reserve: async (source) => source.endsWith(' Details')
      ? { allowed: false, reason: 'daily_budget' }
      : { allowed: true },
  });
  await assert.rejects(
    enrichAtsListingJob({
      platform: 'smartrecruiters',
      slug: 'acme',
      job: { id: 'sr-1' },
      requestTimeoutMs: 10_000,
    }, harness.dependencies),
    (error: unknown) => error instanceof TestAtsPlatformDeferredError
      && error.platform === 'ATS-smartrecruiters'
      && error.retryAt?.toISOString() === '2026-08-27T17:15:00.000Z',
  );
  assert.deepEqual(harness.urls, []);
  assert.deepEqual(harness.failures, []);
});

test('a job-scoped detail 403 is unavailable without poisoning listing or detail circuits', async () => {
  const harness = createHarness({ status: 403, body: 'forbidden' });
  const result = await enrichAtsListingJob({
    platform: 'workday',
    slug: 'acme.wd5::Careers',
    job: { title: 'Channel Manager', externalPath: '/job/REQ-1' },
    requestTimeoutMs: 10_000,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'unavailable');
  assert.equal(marker.httpStatus, 403);
  assert.deepEqual(harness.platformFailurePolicies, [false]);
  assert.deepEqual(harness.failures, []);
});

test('request and response receipt callback failures reject instead of completing enrichment', async (t) => {
  await t.test('request-start receipt fails before the network call', async () => {
    const harness = createHarness({ body: { description: 'Manage partners.' } });
    const receiptError = new Error('request-start receipt write failed');
    await assert.rejects(
      enrichAtsListingJob({
        platform: 'workable',
        slug: 'acme',
        job: { shortcode: 'WK-1' },
        requestTimeoutMs: 10_000,
        onRequestStarted: async () => {
          throw receiptError;
        },
      }, harness.dependencies),
      (error: unknown) => error === receiptError,
    );
    assert.deepEqual(harness.reservations, ['ATS-workable', 'ATS-workable Details']);
    assert.deepEqual(harness.urls, []);
    assert.deepEqual(harness.successes, []);
    assert.deepEqual(harness.failures, []);
  });

  await t.test('response receipt fails after contact but before validation', async () => {
    const harness = createHarness({ body: { description: 'Manage partners.' } });
    const receiptError = new Error('response receipt write failed');
    await assert.rejects(
      enrichAtsListingJob({
        platform: 'workable',
        slug: 'acme',
        job: { shortcode: 'WK-1' },
        requestTimeoutMs: 10_000,
        onResponseReceived: async () => {
          throw receiptError;
        },
      }, harness.dependencies),
      (error: unknown) => error === receiptError,
    );
    assert.deepEqual(harness.urls, ['https://apply.workable.com/api/v1/accounts/acme/jobs/WK-1']);
    assert.deepEqual(harness.successes, []);
    assert.deepEqual(harness.failures, []);
  });
});

test('other endpoint failures fail soft with an auditable unavailable marker', async () => {
  const harness = createHarness({ status: 503, body: 'unavailable' });
  const result = await enrichAtsListingJob({
    platform: 'bamboohr',
    slug: 'acme',
    job: { id: '42' },
    requestTimeoutMs: 10_000,
    ...harness.inputCallbacks,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'unavailable');
  assert.equal(marker.attempted, true);
  assert.equal(marker.reason, 'http_error');
  assert.equal(marker.httpStatus, 503);
  assert.match(marker.error || '', /HTTP 503/);
  assert.deepEqual(harness.successes, []);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].provider, 'ATS-bamboohr Details');
  assert.deepEqual(harness.platformFailurePolicies, [false]);
});

test('a valid response with no usable detail is transport-successful but durably unavailable', async () => {
  const harness = createHarness({ body: { jobAd: { sections: {} } } });
  const result = await enrichAtsListingJob({
    platform: 'smartrecruiters',
    slug: 'acme',
    job: { id: 'sr-1' },
    requestTimeoutMs: 10_000,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'unavailable');
  assert.equal(marker.reason, 'no_usable_detail');
  assert.deepEqual(harness.successes, ['ATS-smartrecruiters Details']);
  assert.deepEqual(harness.failures, []);
});

test('Breezy list compensation does not hide an unavailable JSON-LD detail response', async () => {
  const harness = createHarness({ body: '<html>No JobPosting</html>' });
  const result = await enrichAtsListingJob({
    platform: 'breezy',
    slug: 'acme',
    job: {
      friendly_id: 'br-1',
      salary: '$120,000-$140,000 annual',
    },
    requestTimeoutMs: 10_000,
  }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result);
  assert.ok(marker);
  assert.equal(marker.status, 'unavailable');
  assert.equal(marker.reason, 'no_usable_detail');
  assert.equal(marker.compensation, '$120,000–$140,000 base');
  assert.deepEqual(harness.successes, ['ATS-breezy Details']);
});
