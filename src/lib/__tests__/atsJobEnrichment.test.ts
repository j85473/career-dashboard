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

test('queue and dispatch receipt time do not consume the detail network timeout', async () => {
  const harness = createHarness({ body: { description: '<p>Lead channel growth.</p>' } });
  const schedule = harness.dependencies.fetchPlatformResponse!;
  const fetch = harness.dependencies.fetch!;
  harness.dependencies.fetchPlatformResponse = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return schedule(...args);
  };
  harness.dependencies.fetch = async (url, init) => {
    assert.equal(init?.signal?.aborted, false, 'local waiting spent the network deadline');
    return fetch(url, init);
  };
  const result = await enrichAtsListingJob({
    platform: 'workable', slug: 'acme', job: { shortcode: 'WK-TIME' }, requestTimeoutMs: 20,
    onRequestStarted: () => new Promise((resolve) => setTimeout(resolve, 40)),
  }, harness.dependencies);
  assert.equal(readAtsJobEnrichmentMarker(result)?.status, 'enriched');
  assert.equal(harness.urls.length, 1);
});

test('detail timeout covers reading the response body after headers arrive', async () => {
  const harness = createHarness();
  let bodyAborted = false;
  harness.dependencies.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener('abort', () => {
        bodyAborted = true;
        controller.error(init!.signal!.reason);
      }, { once: true });
    },
  }), { status: 200 });
  // AbortSignal.timeout is unref'ed; keep the event loop alive for the test.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(enrichAtsListingJob({
      platform: 'workable', slug: 'acme', job: { shortcode: 'WK-BODY' }, requestTimeoutMs: 20,
    }, harness.dependencies), TestAtsPlatformDeferredError);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(bodyAborted, true);
  assert.deepEqual(harness.successes, []);
});

test('an abort while queued prevents detail reservations and dispatch', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  harness.dependencies.fetchPlatformResponse = async (_platform, signal, request) => {
    controller.abort(new Error('worker stopping while queued'));
    assert.equal(signal?.aborted, true);
    return request();
  };
  await assert.rejects(enrichAtsListingJob({
    platform: 'workable', slug: 'acme', job: { shortcode: 'WK-ABORT' },
    requestTimeoutMs: 10_000, signal: controller.signal,
  }, harness.dependencies), TestAtsPlatformDeferredError);
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


test('Eightfold recovers the matching full description and preserves employer and location evidence', async () => {
  const harness = createHarness({ body: { status: 200, data: { id: 123,
    jobDescription: '<p>Lead channel partnerships and customer growth.</p>',
    locations: ['Minneapolis, MN, US', 'Chicago, IL, US'], workLocationOption: 'remote_local' } } });
  const result = await enrichAtsListingJob({ platform: 'eightfold', slug: 'kraftheinz.eightfold.ai',
    job: { id: 123, name: 'Channel Manager', eightfoldDomain: 'kraftheinz.com', eightfoldCompany: 'Kraft Heinz' },
    requestTimeoutMs: 10000 }, harness.dependencies);
  const marker = readAtsJobEnrichmentMarker(result)!;
  assert.equal(marker.status, 'enriched');
  assert.match(marker.description!, /Lead channel partnerships/);
  assert.equal(marker.company, 'Kraft Heinz');
  assert.equal(marker.location, 'Remote — Minneapolis, MN, US; Chicago, IL, US');
  const url = new URL(harness.urls[0]);
  assert.equal(url.pathname, '/api/pcsx/position_details');
  assert.equal(url.searchParams.get('domain'), 'kraftheinz.com');
  assert.equal(url.searchParams.get('position_id'), '123');
});

test('Eightfold refuses a detail response for a different posting', async () => {
  const harness = createHarness({ body: { status: 200, data: { id: 999, jobDescription: 'Other posting' } } });
  const result = await enrichAtsListingJob({ platform: 'eightfold', slug: 'kraftheinz.eightfold.ai',
    job: { id: 123, name: 'Channel Manager', eightfoldDomain: 'kraftheinz.com' }, requestTimeoutMs: 10000 }, harness.dependencies);
  assert.equal(readAtsJobEnrichmentMarker(result)!.status, 'unavailable');
  assert.equal(readAtsJobEnrichmentMarker(result)!.description, null);
});


test('Oracle listing enrichment replaces the stub with full detail and retains site branding', async () => {
  const slug = 'ehtl.fa.us6.oraclecloud.com::CX';
  const url = 'https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19195/';
  const h = createHarness({ body: { items: [{ Id: '19195', Title: 'Channel Manager',
    ExternalDescriptionStr: '<p>Manage channel performance.</p>', ExternalResponsibilitiesStr: '<p>Enable distributors.</p>',
    workLocation: [{ TownOrCity: 'Chicago', Region2: 'IL', Country: 'US' }] }] } });
  const enriched = await enrichAtsListingJob({ platform: 'oracle', slug, requestTimeoutMs: 1000,
    job: { id: `${slug}::19195`, publicAtsPostingId: '19195', title: 'Channel Manager', company: 'Resideo', location: 'United States', url } }, h.dependencies);
  const marker = readAtsJobEnrichmentMarker(enriched)!;
  assert.equal(marker.status, 'enriched');
  assert.equal(marker.company, 'Resideo');
  assert.equal(marker.location, 'Chicago, IL');
  assert.match(marker.description!, /Manage channel performance/);
  assert.match(marker.description!, /Enable distributors/);
  assert.match(new URL(h.urls[0]).searchParams.get('finder')!, /Id="19195",siteNumber=CX/);
});

test('UKG listing enrichment reads exact opportunity details and same-board employer branding', async () => {
  const slug = 'recruiting2.ultipro.com::dre1001dryg::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
  const path = '/dre1001dryg/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
  const id = '728fb6e4-c49c-48f8-9099-28eb36d8a552';
  const url = `https://recruiting2.ultipro.com${path}/OpportunityDetail?opportunityId=${id}`;
  const h = createHarness({ body: `<img data-automation="navbar-large-logo" alt="Dreyer's Grand Ice Cream" src="${path}/Styles/GetLargeHeaderLogo">
    <script>new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({ Id: id, Title: 'Distributor Account Manager',
      Description: '<p>Full distributor sales description.</p>', Locations: [{ LocalizedDescription: 'TX - Remote' }] })});</script>` });
  const enriched = await enrichAtsListingJob({ platform: 'ukg', slug, requestTimeoutMs: 1000,
    job: { id: `${slug}::${id}`, publicAtsPostingId: id, title: 'Distributor Account Manager', url } }, h.dependencies);
  const marker = readAtsJobEnrichmentMarker(enriched)!;
  assert.equal(marker.status, 'enriched');
  assert.equal(marker.company, "Dreyer's Grand Ice Cream");
  assert.equal(marker.location, 'TX - Remote');
  assert.match(marker.description!, /Full distributor sales description/);
  assert.equal(h.urls[0], url);
});

// These requests share one detail circuit. Repeated bad postings must remain
// auditable without blocking the healthy request that follows them.
const oracleDetailScopeInput: Parameters<typeof enrichAtsListingJob>[0] = {
  platform: 'oracle', slug: 'acme.fa.us6.oraclecloud.com::CX', requestTimeoutMs: 1000,
  job: { publicAtsPostingId: '123', title: 'Channel Manager',
    url: 'https://acme.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123/' },
};
const healthyOracleDetail = { items: [{ Id: '123', Title: 'Channel Manager',
  LegalEmployer: 'Acme', ExternalDescriptionStr: 'Manage channel performance.' }] };
const ukgDetailScopeInput: Parameters<typeof enrichAtsListingJob>[0] = {
  platform: 'ukg', requestTimeoutMs: 1000,
  slug: 'recruiting2.ultipro.com::acme1001::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b',
  job: { publicAtsPostingId: '728fb6e4-c49c-48f8-9099-28eb36d8a552', title: 'Channel Manager',
    url: 'https://recruiting2.ultipro.com/acme1001/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b/OpportunityDetail?opportunityId=728fb6e4-c49c-48f8-9099-28eb36d8a552' },
};
const ukgPostingWithoutBranding = `<script>new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({
  Id: ukgDetailScopeInput.job.publicAtsPostingId, Title: 'Channel Manager', Description: 'Manage channel performance.',
})});</script>`;
const healthyUkgDetail = '<img data-automation="navbar-large-logo" alt="Acme" src="/acme1001/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b/Styles/GetLargeHeaderLogo">'
  + ukgPostingWithoutBranding;
const eightfoldDetailScopeInput: Parameters<typeof enrichAtsListingJob>[0] = {
  platform: 'eightfold', slug: 'acme.eightfold.ai', requestTimeoutMs: 1000,
  job: { id: 123, name: 'Channel Manager', eightfoldCompany: 'Acme' },
};
const healthyEightfoldDetail = { status: 200, data: { id: 123, jobDescription: 'Manage channel performance.' } };
const jobScopedDetailCases: Array<{
  name: string;
  input: Parameters<typeof enrichAtsListingJob>[0];
  body: unknown;
  healthyBody: unknown;
  error: RegExp;
}> = [
  { name: 'Oracle posting identity mismatch', input: oracleDetailScopeInput,
    body: { items: [{ Id: '999', ExternalDescriptionStr: 'Wrong posting.' }] },
    healthyBody: healthyOracleDetail, error: /schema or posting identity mismatch/ },
  { name: 'Oracle missing description', input: oracleDetailScopeInput,
    body: { items: [{ Id: '123', LegalEmployer: 'Acme' }] },
    healthyBody: healthyOracleDetail, error: /schema or posting identity mismatch/ },
  { name: 'Oracle missing employer', input: oracleDetailScopeInput,
    body: { items: [{ Id: '123', ExternalDescriptionStr: 'Manage channel performance.' }] },
    healthyBody: healthyOracleDetail, error: /no authoritative employer/ },
  { name: 'Oracle invalid JSON', input: oracleDetailScopeInput,
    body: '<html>Posting unavailable</html>', healthyBody: healthyOracleDetail, error: /Unexpected token/ },
  { name: 'UKG posting identity mismatch', input: ukgDetailScopeInput,
    body: ukgPostingWithoutBranding.replace(String(ukgDetailScopeInput.job.publicAtsPostingId), '999'),
    healthyBody: healthyUkgDetail, error: /schema or posting identity mismatch/ },
  { name: 'UKG missing employer', input: ukgDetailScopeInput,
    body: ukgPostingWithoutBranding, healthyBody: healthyUkgDetail, error: /no authoritative employer/ },
  { name: 'Eightfold posting identity mismatch', input: eightfoldDetailScopeInput,
    body: { status: 200, data: { id: 999, jobDescription: 'Wrong posting.' } },
    healthyBody: healthyEightfoldDetail, error: /schema or posting identity mismatch/ },
  { name: 'Eightfold invalid JSON', input: eightfoldDetailScopeInput,
    body: '<html>Posting unavailable</html>', healthyBody: healthyEightfoldDetail, error: /Unexpected token/ },
  { name: 'Workday invalid JSON', input: { platform: 'workday', slug: 'acme.wd5::Careers',
    requestTimeoutMs: 1000, job: { title: 'Channel Manager', externalPath: '/job/REQ-1' } },
    body: '<html>Posting unavailable</html>',
    healthyBody: { jobPostingInfo: { jobDescription: 'Manage channel performance.' } }, error: /Unexpected token/ },
];

for (const fixture of jobScopedDetailCases) {
  test(`repeated ${fixture.name} leaves healthy detail requests available`, async () => {
    const bad = createHarness({ body: fixture.body });
    const healthy = createHarness({ body: fixture.healthyBody });
    const failures: Array<{ provider: string; error: unknown }> = [];
    const circuit = { open: false };
    const sharedControl: Partial<AtsJobEnrichmentDependencies> = {
      reserveProviderBudgetForSource: async (source) => ({
        allowed: !source.endsWith(' Details') || !circuit.open,
        reason: circuit.open ? 'circuit_open' : undefined,
      }),
      recordProviderFailure: async (failure) => {
        failures.push(failure);
        circuit.open = true;
        return null;
      },
    };
    const original = structuredClone(fixture.input.job);
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await enrichAtsListingJob(fixture.input, { ...bad.dependencies, ...sharedControl });
      const marker = readAtsJobEnrichmentMarker(result)!;
      assert.equal(marker.status, 'unavailable');
      assert.equal(marker.attempted, true);
      assert.equal(marker.reason, 'endpoint_error');
      assert.equal(marker.description, null, 'unverified detail must not reach the job');
      assert.match(marker.error || '', fixture.error);
    }
    assert.deepEqual(fixture.input.job, original, 'the saved listing must remain unchanged');
    assert.deepEqual(failures, [], 'a bad posting must not open the shared detail circuit');
    assert.deepEqual(bad.successes, [], 'unusable detail must not be reported as provider success');
    const result = await enrichAtsListingJob(fixture.input, { ...healthy.dependencies, ...sharedControl });
    assert.equal(readAtsJobEnrichmentMarker(result)!.status, 'enriched');
    assert.match(readAtsJobEnrichmentMarker(result)!.description!, /Manage channel performance/);
    assert.deepEqual(healthy.successes, [`ATS-${fixture.input.platform} Details`]);
  });
}

test('a failed JSON response body still records a transport failure for shared detail protection', async () => {
  const harness = createHarness();
  const bodyError = new TypeError('detail response connection terminated');
  harness.dependencies.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.error(bodyError); },
  }));
  const result = await enrichAtsListingJob({ platform: 'workday', slug: 'acme.wd5::Careers',
    job: { title: 'Channel Manager', externalPath: '/job/REQ-1' }, requestTimeoutMs: 1000 }, harness.dependencies);
  assert.equal(readAtsJobEnrichmentMarker(result)!.status, 'unavailable');
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].provider, 'ATS-workday Details');
  assert.equal(harness.failures[0].error, bodyError);
});
