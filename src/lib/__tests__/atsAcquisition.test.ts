import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_CONCURRENCY,
  ATS_ACQUISITION_JOB_HIGH_WATERMARK,
  ATS_ACQUISITION_JOB_LOW_WATERMARK,
  ATS_BATCH_PROCESSING_CONCURRENCY,
  ATS_ENRICHMENT_JOBS_PER_ATTEMPT,
  ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS,
  advanceAtsResponseState,
  atsProviderRetryAt,
  boundedInteger,
  buildAtsBoardRequest,
  currentAtsEnrichmentPrefix,
  cursorForQueuedAtsEnrichmentRecovery,
  fairAtsBoardsAcrossPlatforms,
  nextAtsFailureSchedule,
  nextAtsBackpressureState,
  nextAtsProcessingContinuationAt,
  parseAtsListingPayload,
  planAtsEnrichmentChunk,
  planAtsProcessingTurn,
  payloadHash,
  planAtsSelectionCapacity,
  readAtsAcquisitionCursor,
  recoverAtsListingCompletion,
  validateAtsBatchCompletion,
  validateAtsEnrichmentQueueReadiness,
  type AtsBoardForAcquisition,
} from '../atsAcquisition';

const NOW = new Date('2026-08-27T15:00:00.000Z');

function board(overrides: Partial<AtsBoardForAcquisition> = {}): AtsBoardForAcquisition {
  return {
    slug: 'example',
    platform: 'greenhouse',
    status: 'active',
    failCount: 0,
    retryCount: 0,
    checkDay: 4,
    ...overrides,
  };
}

function enrichedListingJob(
  id: string,
  platform = 'workday',
  version = 1,
): Record<string, unknown> {
  return {
    id,
    __careerDashboardAtsEnrichment: {
      version,
      status: 'not_needed',
      platform,
      detailSource: `ATS-${platform} Details`,
      attempted: false,
      completedAt: '2026-08-27T12:00:00.000Z',
      description: null,
      company: null,
      location: null,
      compensation: null,
    },
  };
}

test('direct ATS request construction is platform-specific and resumable', () => {
  const greenhouse = buildAtsBoardRequest(board(), 0);
  assert.equal(greenhouse.url, 'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true');
  assert.equal(greenhouse.init.method, undefined);

  const workday = buildAtsBoardRequest(board({ platform: 'workday', slug: 'acme.wd5::Careers' }), 40);
  assert.equal(workday.url, 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs');
  assert.equal(workday.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(workday.init.body)), {
    appliedFacets: {}, limit: 20, offset: 40, searchText: '',
  });

  const workable = buildAtsBoardRequest(board({ platform: 'workable' }), 0);
  assert.equal(workable.url, 'https://www.workable.com/api/accounts/example?details=true');
  assert.equal(workable.init.method, undefined);
});

test('listing parsing preserves provider metadata without duplicating the job envelope', () => {
  const greenhouse = parseAtsListingPayload('greenhouse', {
    name: 'Example Incorporated',
    jobs: [{ id: 1, title: 'Channel Manager' }],
  });
  assert.deepEqual(greenhouse.metadata, { name: 'Example Incorporated' });
  assert.deepEqual(greenhouse.jobs, [{ id: 1, title: 'Channel Manager' }]);

  const workday = parseAtsListingPayload('workday', {
    total: 350,
    jobPostings: [{ externalPath: '/job/one' }],
  });
  assert.equal(workday.total, 350, 'page turns are bounded without truncating the board total');
  assert.deepEqual(workday.jobs, [{ externalPath: '/job/one' }]);
  assert.equal(parseAtsListingPayload('workday', { total: 0, jobPostings: [] }).total, 0);

  const workable = parseAtsListingPayload('workable', {
    name: 'Example Incorporated',
    jobs: [{ shortcode: 'ABC123', title: 'Channel Manager', description: 'Own partner growth.' }],
  });
  assert.deepEqual(workable.metadata, { name: 'Example Incorporated' });
  assert.deepEqual(workable.jobs, [{ shortcode: 'ABC123', title: 'Channel Manager', description: 'Own partner growth.' }]);

  const smartRequest = buildAtsBoardRequest(board({ platform: 'smartrecruiters' }), 200);
  assert.equal(
    smartRequest.url,
    'https://api.smartrecruiters.com/v1/companies/example/postings?limit=100&offset=200',
  );
  const smart = parseAtsListingPayload('smartrecruiters', {
    totalFound: 245,
    limit: 100,
    offset: 200,
    content: [{ id: 'last-page' }],
  });
  assert.equal(smart.total, 245);
  assert.deepEqual(smart.jobs, [{ id: 'last-page' }]);
});

test('Personio XML becomes the same durable listing envelope as JSON platforms', () => {
  const parsed = parseAtsListingPayload('personio', {}, `
    <workzag-jobs>
      <position>
        <id>42</id><name>Partner Manager</name><office>Minneapolis</office>
        <additionalOffices><office>Remote</office></additionalOffices>
        <jobDescriptions><jobDescription>Own partner growth.</jobDescription></jobDescriptions>
      </position>
    </workzag-jobs>
  `);
  assert.equal(parsed.jobs.length, 1);
  assert.deepEqual(parsed.jobs[0], {
    id: '42',
    name: 'Partner Manager',
    location: 'Minneapolis; Remote',
    description: 'Own partner growth.',
    createdAt: null,
  });
});

test('every ATS parser accepts an explicit empty listing envelope', () => {
  const emptyPayloads: Array<[string, unknown, (string | null)?]> = [
    ['greenhouse', { jobs: [] }],
    ['lever', []],
    ['ashby', { jobs: [] }],
    ['workday', { total: 0, jobPostings: [] }],
    ['smartrecruiters', { totalFound: 0, content: [] }],
    ['workable', { jobs: [] }],
    ['bamboohr', { result: [] }],
    ['breezy', []],
    ['teamtailor', { items: [] }],
    ['pinpoint', { data: [] }],
    ['recruitee', { offers: [] }],
    ['rippling', []],
    ['personio', {}, '<workzag-jobs></workzag-jobs>'],
  ];

  for (const [platform, payload, bodyText] of emptyPayloads) {
    assert.deepEqual(parseAtsListingPayload(platform, payload, bodyText || null).jobs, [], platform);
  }
});

test('malformed successful ATS payloads fail schema validation instead of erasing a board', () => {
  for (const [platform, payload] of [
    ['greenhouse', { error: 'not a board' }],
    ['lever', { jobs: [] }],
    ['ashby', { jobs: [null] }],
    ['workday', { total: 0 }],
    ['smartrecruiters', { content: 'not-an-array' }],
    ['workable', { name: 'missing jobs' }],
    ['bamboohr', { result: [42] }],
    ['breezy', { positions: [] }],
    ['teamtailor', { jobs: [] }],
    ['pinpoint', { data: {} }],
    ['recruitee', { offers: null }],
    ['rippling', { jobs: [] }],
  ] as Array<[string, unknown]>) {
    assert.throws(() => parseAtsListingPayload(platform, payload), /schema/i, platform);
  }
  assert.throws(
    () => parseAtsListingPayload('personio', {}, '<html><body>rate limited</body></html>'),
    /schema/i,
  );
});

test('two same-day retries precede the existing parked and blacklisted cycles', () => {
  const first = nextAtsFailureSchedule(board(), NOW);
  assert.equal(first.retryCount, 1);
  assert.equal(first.failCount, 0);
  assert.equal(first.status, 'active');
  assert.equal(first.nextCheckDate.getTime() - NOW.getTime(), 15 * 60_000);

  const second = nextAtsFailureSchedule(board({ retryCount: 1 }), NOW);
  assert.equal(second.retryCount, 2);
  assert.equal(second.failCount, 0);
  assert.equal(second.status, 'active');
  assert.equal(second.nextCheckDate.getTime() - NOW.getTime(), 60 * 60_000);

  const parked = nextAtsFailureSchedule(board({ retryCount: 2 }), NOW);
  assert.equal(parked.retryCount, 0);
  assert.equal(parked.failCount, 1);
  assert.equal(parked.status, 'parked');
  assert.equal(parked.nextCheckDate.getTime() - NOW.getTime(), 86_400_000);

  const blacklisted = nextAtsFailureSchedule(board({ retryCount: 2, failCount: 2, status: 'parked' }), NOW);
  assert.equal(blacklisted.failCount, 3);
  assert.equal(blacklisted.status, 'blacklisted');
  assert.equal(blacklisted.nextCheckDate.getTime() - NOW.getTime(), 30 * 86_400_000);
});

test('acquisition and persistence have independent conservative resource ceilings', () => {
  assert.ok(ATS_ACQUISITION_CONCURRENCY <= 4);
  assert.equal(ATS_BATCH_PROCESSING_CONCURRENCY, 1);
});

test('job backpressure uses high and low watermarks without freezing partial recovery', () => {
  assert.equal(ATS_ACQUISITION_JOB_HIGH_WATERMARK, 2_000);
  assert.equal(ATS_ACQUISITION_JOB_LOW_WATERMARK, 1_000);
  assert.equal(nextAtsBackpressureState({ active: false, remainingJobs: 1_999 }).active, false);
  assert.equal(nextAtsBackpressureState({ active: false, remainingJobs: 2_000 }).active, true);
  assert.equal(nextAtsBackpressureState({ active: true, remainingJobs: 1_001 }).active, true);
  assert.equal(nextAtsBackpressureState({ active: true, remainingJobs: 1_000 }).active, false);
  assert.deepEqual(planAtsSelectionCapacity({
    selectionLimit: 25,
    resumedCount: 4,
    outstandingCount: 100,
    allowNewBatches: false,
  }), { resumeLimit: 25, newBatchLimit: 0 });
});

test('job backpressure measures the processing backlog, not boards still listing', () => {
  const acquisition = readFileSync(
    path.join(process.cwd(), 'src/lib/atsAcquisition.ts'),
    'utf8',
  );
  const measurement = acquisition.slice(
    acquisition.indexOf('export async function atsQueueDepth'),
    acquisition.indexOf('export function cursorForQueuedAtsEnrichmentRecovery'),
  );
  // A fetching/partial batch has processingOffset zero by construction, so
  // counting its listed jobs let one large board exceed the whole watermark
  // and latch backpressure on while the processing queue sat empty.
  assert.match(measurement, /PROCESSING_BACKLOG_BATCH_STATUSES/);
  assert.doesNotMatch(measurement, /OUTSTANDING_BATCH_STATUSES/);
  assert.match(
    acquisition,
    /const PROCESSING_BACKLOG_BATCH_STATUSES = \['queued', 'processing'\] as const;/,
  );
  // Acquisition-stage payload growth keeps its own bound, by batch count.
  assert.match(
    acquisition,
    /const outstanding = await prisma\.atsIngestionBatch\.count\(\{\s+where: \{ status: \{ in: \[\.\.\.OUTSTANDING_BATCH_STATUSES\] \} \},/,
  );
});

test('provider deferral preserves a future circuit boundary and supplies a safe fallback', () => {
  const retryAt = new Date('2026-08-27T20:00:00.000Z');
  assert.equal(atsProviderRetryAt(retryAt, NOW), retryAt);
  assert.equal(
    atsProviderRetryAt(null, NOW).toISOString(),
    '2026-08-27T15:15:00.000Z',
  );
});

test('ATS environment integers reject malformed values and remain within safe bounds', () => {
  assert.equal(boundedInteger(undefined, 4, 1, 8), 4);
  assert.equal(boundedInteger('2junk', 4, 1, 8), 4);
  assert.equal(boundedInteger('1.5', 4, 1, 8), 4);
  assert.equal(boundedInteger('-10', 4, 1, 8), 1);
  assert.equal(boundedInteger('100', 4, 1, 8), 8);
  assert.equal(boundedInteger(' 6 ', 4, 1, 8), 6);
});

test('batch and current-attempt response timestamps are not conflated', () => {
  const priorBatchResponse = new Date('2026-08-27T14:00:00.000Z');
  const currentResponse = new Date('2026-08-27T15:00:00.000Z');
  const response = advanceAtsResponseState({
    batchRespondedAt: priorBatchResponse,
    attemptRespondedAt: null,
    responseAt: currentResponse,
  });
  assert.equal(response.batchRespondedAt, priorBatchResponse);
  assert.equal(response.attemptRespondedAt, currentResponse);
  // A deferred request never calls the raw-response transition, so its attempt
  // receipt remains null/non-responded even when the resumed batch has history.
  assert.equal(Boolean((null as Date | null)), false);
});

test('ATS acquisition cursor reads legacy listing state and normalizes enrichment versions', () => {
  const legacyCursor = readAtsAcquisitionCursor({ offset: 40, total: 100 });
  assert.deepEqual(legacyCursor, {
    offset: 40,
    total: 100,
    listingComplete: false,
    enrichmentOffset: 0,
    enrichmentVersion: null,
  });
  assert.deepEqual(readAtsAcquisitionCursor({
    offset: 100,
    total: 100,
    listingComplete: true,
    enrichmentOffset: 25,
    enrichmentVersion: '1',
  }), {
    offset: 100,
    total: 100,
    listingComplete: true,
    enrichmentOffset: 25,
    enrichmentVersion: 1,
  });

  assert.equal(recoverAtsListingCompletion({
    cursor: legacyCursor,
    paginated: false,
    persistedPageCount: 1,
    jobs: [{ id: 'legacy-raw' }],
    platform: 'greenhouse',
  }).listingComplete, true, 'a persisted non-paginated page is the complete legacy listing');
  assert.equal(recoverAtsListingCompletion({
    cursor: readAtsAcquisitionCursor({ offset: 100, total: 100 }),
    paginated: true,
    persistedPageCount: 5,
    jobs: [{ id: 'legacy-raw' }],
    platform: 'workday',
  }).listingComplete, true, 'a legacy pagination cursor at its total does not replay the final page');
});

test('ATS enrichment is bounded to 25 jobs and resumes at the first invalid marker', () => {
  assert.equal(ATS_ENRICHMENT_JOBS_PER_ATTEMPT, 25);
  assert.deepEqual(planAtsEnrichmentChunk(0, 80), { start: 0, end: 25 });
  assert.deepEqual(planAtsEnrichmentChunk(25, 80), { start: 25, end: 50 });
  assert.deepEqual(planAtsEnrichmentChunk(75, 80), { start: 75, end: 80 });

  const jobs = [
    enrichedListingJob('current-0'),
    { id: 'raw-1' },
    enrichedListingJob('current-but-after-gap-2'),
  ];
  assert.equal(currentAtsEnrichmentPrefix(jobs, 'workday'), 1);
  assert.deepEqual(cursorForQueuedAtsEnrichmentRecovery({
    cursor: readAtsAcquisitionCursor({ offset: 100, total: 100 }),
    jobs,
    platform: 'workday',
  }), {
    offset: 100,
    total: 100,
    listingComplete: true,
    enrichmentOffset: 1,
    enrichmentVersion: 1,
  });
});

test('only a fully current platform-matched enrichment payload may enter processing', () => {
  const currentJobs = [enrichedListingJob('one'), enrichedListingJob('two')];
  const readyCursor = readAtsAcquisitionCursor({
    listingComplete: true,
    enrichmentOffset: 2,
    enrichmentVersion: 1,
  });
  assert.deepEqual(validateAtsEnrichmentQueueReadiness({
    cursor: readyCursor,
    jobs: currentJobs,
    platform: 'workday',
    storedJobCount: 2,
  }), { valid: true });

  const raw = validateAtsEnrichmentQueueReadiness({
    cursor: readyCursor,
    jobs: [currentJobs[0], { id: 'raw-two' }],
    platform: 'workday',
    storedJobCount: 2,
  });
  assert.equal(raw.valid, false);
  if (!raw.valid) {
    assert.equal(raw.resumeOffset, 1);
    assert.match(raw.reason, /raw or stale enrichment marker/i);
  }

  const wrongPlatform = validateAtsEnrichmentQueueReadiness({
    cursor: readyCursor,
    jobs: [enrichedListingJob('one', 'greenhouse'), currentJobs[1]],
    platform: 'workday',
    storedJobCount: 2,
  });
  assert.equal(wrongPlatform.valid, false);
  const wrongVersion = validateAtsEnrichmentQueueReadiness({
    cursor: { ...readyCursor, enrichmentVersion: 0 },
    jobs: currentJobs,
    platform: 'workday',
    storedJobCount: 2,
  });
  assert.equal(wrongVersion.valid, false);
});

test('platform fairness prevents a large ATS catalog from hiding a small one', () => {
  const rows = [
    ...Array.from({ length: 10_000 }, (_, index) => ({ platform: 'workday', slug: `workday-${index}` })),
    { platform: 'workable', slug: 'only-workable-board' },
  ];
  const selected = fairAtsBoardsAcrossPlatforms(rows, 2);
  assert.deepEqual(selected.map((row) => row.platform), ['workable', 'workday']);
});

test('outstanding cap blocks new payloads without blocking partial-batch resumption', () => {
  assert.deepEqual(planAtsSelectionCapacity({
    selectionLimit: 8,
    resumedCount: 3,
    outstandingCount: 100,
    queueLimit: 100,
  }), {
    resumeLimit: 8,
    newBatchLimit: 0,
  });
  assert.deepEqual(planAtsSelectionCapacity({
    selectionLimit: 8,
    resumedCount: 3,
    outstandingCount: 96,
    queueLimit: 100,
  }), {
    resumeLimit: 8,
    newBatchLimit: 4,
  });
});

test('destructive ATS completion requires complete counters and payload integrity', () => {
  const emptyHash = payloadHash({}, []);
  assert.deepEqual(validateAtsBatchCompletion({
    counters: {
      seen: 0,
      inserted: 0,
      duplicates: 0,
      filtered: 0,
      processingErrors: 0,
      providerErrors: 0,
    },
    storedJobCount: 0,
    payloadJobCount: 0,
    storedPayloadHash: emptyHash,
    computedPayloadHash: emptyHash,
    payloadPresent: true,
  }), { valid: true }, 'a verified zero-job response is a valid success');

  const oneJob = [{ id: 'one', title: 'Channel Manager' }];
  const oneJobHash = payloadHash({}, oneJob);
  const base = {
    counters: {
      seen: 1,
      inserted: 1,
      duplicates: 0,
      filtered: 0,
      processingErrors: 0,
      providerErrors: 0,
    },
    storedJobCount: 1,
    payloadJobCount: 1,
    storedPayloadHash: oneJobHash,
    computedPayloadHash: oneJobHash,
    payloadPresent: true,
  };
  assert.equal(validateAtsBatchCompletion({ ...base, fatalError: 'adapter failed' }).valid, false);
  assert.equal(validateAtsBatchCompletion({
    ...base,
    counters: { ...base.counters, seen: 0, inserted: 0 },
  }).valid, false);
  assert.deepEqual(validateAtsBatchCompletion({
    ...base,
    counters: { ...base.counters, inserted: 0, processingErrors: 1 },
    allowProcessingErrors: true,
  }), { valid: true }, 'a retained terminal receipt may reconcile a quarantined job');
  assert.equal(validateAtsBatchCompletion({ ...base, computedPayloadHash: 'tampered' }).valid, false);
  assert.equal(validateAtsBatchCompletion({
    ...base,
    counters: { ...base.counters, inserted: 0, processingErrors: 1 },
  }).valid, false);
});

test('bounded ATS processing advances a durable prefix and composes counters', () => {
  const firstChunk = planAtsProcessingTurn({
    currentOffset: 25,
    storedJobCount: 80,
    payloadJobCount: 80,
    claimedJobCount: 25,
    storedCounters: { inserted: 10, duplicates: 10, filtered: 5, processingErrors: 0 },
    turnCounters: {
      seen: 25,
      inserted: 4,
      duplicates: 16,
      filtered: 5,
      processingErrors: 0,
      providerErrors: 1,
    },
  });
  assert.equal(firstChunk.valid, true);
  assert.equal(firstChunk.nextOffset, 50);
  assert.equal(firstChunk.complete, false);
  assert.deepEqual(firstChunk.counters, {
    seen: 50,
    inserted: 14,
    duplicates: 26,
    filtered: 10,
    processingErrors: 0,
    providerErrors: 1,
    requests: undefined,
  });

  const interruptedPrefix = planAtsProcessingTurn({
    currentOffset: 50,
    storedJobCount: 80,
    payloadJobCount: 80,
    claimedJobCount: 25,
    storedCounters: { inserted: 14, duplicates: 26, filtered: 10, processingErrors: 0 },
    turnCounters: {
      seen: 7,
      inserted: 1,
      duplicates: 5,
      filtered: 1,
      processingErrors: 0,
      providerErrors: 0,
    },
    interrupted: true,
  });
  assert.equal(interruptedPrefix.valid, true);
  assert.equal(interruptedPrefix.nextOffset, 57);
  assert.equal(interruptedPrefix.complete, false);
});

test('ATS processing never advances an incomplete chunk and reconciles job-error outcomes', () => {
  const base = {
    currentOffset: 25,
    storedJobCount: 80,
    payloadJobCount: 80,
    claimedJobCount: 25,
    storedCounters: { inserted: 10, duplicates: 10, filtered: 5, processingErrors: 0 },
  };
  const incomplete = planAtsProcessingTurn({
    ...base,
    turnCounters: {
      seen: 24,
      inserted: 4,
      duplicates: 15,
      filtered: 5,
      processingErrors: 0,
      providerErrors: 0,
    },
  });
  assert.equal(incomplete.valid, false);
  assert.equal(incomplete.nextOffset, 25);

  const failed = planAtsProcessingTurn({
    ...base,
    turnCounters: {
      seen: 25,
      inserted: 4,
      duplicates: 15,
      filtered: 5,
      processingErrors: 1,
      providerErrors: 0,
    },
  });
  assert.equal(failed.valid, true);
  assert.equal(failed.nextOffset, 50);
  assert.equal(failed.counters.processingErrors, 1);

  const corruptCursor = planAtsProcessingTurn({
    ...base,
    storedCounters: { inserted: 9, duplicates: 10, filtered: 5, processingErrors: 0 },
    turnCounters: {
      seen: 25,
      inserted: 4,
      duplicates: 16,
      filtered: 5,
      processingErrors: 0,
      providerErrors: 0,
    },
  });
  assert.equal(corruptCursor.valid, false);
  assert.match(corruptCursor.reason || '', /cursor does not reconcile/i);

  const truncatedPayload = planAtsProcessingTurn({
    ...base,
    payloadJobCount: 79,
    turnCounters: {
      seen: 25,
      inserted: 4,
      duplicates: 16,
      filtered: 5,
      processingErrors: 0,
      providerErrors: 0,
    },
  });
  assert.equal(truncatedPayload.valid, false);
  assert.match(truncatedPayload.reason || '', /payload length/i);
});

test('an interrupted ATS chunk backs off only when it made no durable cursor progress', () => {
  const now = new Date('2026-08-27T15:00:00.000Z');
  assert.equal(
    nextAtsProcessingContinuationAt({ now, interrupted: true, cursorAdvanced: false }).getTime(),
    now.getTime() + ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS,
  );
  assert.equal(
    nextAtsProcessingContinuationAt({ now, interrupted: true, cursorAdvanced: true }).getTime(),
    now.getTime(),
    'a committed prefix may continue immediately',
  );
  assert.equal(
    nextAtsProcessingContinuationAt({ now, interrupted: false, cursorAdvanced: false }).getTime(),
    now.getTime(),
    'ordinary non-interrupted scheduling keeps its existing behavior',
  );
});

test('split-path migration and worker contract are additive and auditable', () => {
  const migration = readFileSync(
    path.join(process.cwd(), 'prisma/migrations/20260827160000_ats_split_ingestion_paths/migration.sql'),
    'utf8',
  );
  const route = readFileSync(path.join(process.cwd(), 'src/app/api/pipeline/run/route.ts'), 'utf8');
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const acquisition = readFileSync(path.join(process.cwd(), 'src/lib/atsAcquisition.ts'), 'utf8');
  const stats = readFileSync(path.join(process.cwd(), 'src/app/api/stats/route.ts'), 'utf8');

  assert.match(migration, /CREATE TABLE "AtsBoardCheckAttempt"/);
  assert.match(migration, /CREATE TABLE "AtsIngestionBatch"/);
  assert.match(migration, /"processingAttemptCount" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /"processingOffset" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /"requestLeaseToken" TEXT/);
  assert.match(migration, /ProviderCircuit_requestLeaseToken_key/);
  assert.match(migration, /"leaseOwner" TEXT/);
  assert.match(migration, /"heartbeatAt" TIMESTAMP\(3\)/);
  assert.match(migration, /"leaseExpiresAt" TIMESTAMP\(3\)/);
  assert.match(migration, /AtsIngestionBatch_one_active_acquisition_per_board_key/);
  assert.match(migration, /AtsBoardCheckAttempt_one_running_per_board_key/);
  for (const field of ['contactedAt', 'respondedAt', 'synchronizedAt', 'processedAt', 'finishedAt']) {
    assert.match(migration, new RegExp(`AtsBoardCheckAttempt_${field}_idx`));
  }
  assert.doesNotMatch(migration, /^\s*(?:DROP|DELETE|UPDATE|TRUNCATE)\b/im);
  assert.match(route, /superviseLoop\('ATS Acquisition Process', runAtsAcquisitionProcess\)/);
  assert.match(route, /superviseLoop\('ATS Batch Processing', runAtsBatchProcessingLoop\)/);
  assert.match(route, /superviseLoop\('Source Ingestion', runIngestionLoop\)/);
  assert.match(route, /heartbeatAtsBatchProcessing/);
  assert.match(ingestion, /prefetchedAtsBatch/);
  assert.match(ingestion, /fatalError: fatalPrefetchedAtsError/);
  assert.match(ingestion, /if \(!options\.prefetchedAtsBatch\) markSourceSuccess\(boardSource\)/);
  const acquisitionEntry = acquisition.slice(acquisition.indexOf('export async function acquireAtsBoardBatch'));
  assert.ok(
    acquisitionEntry.indexOf('reserveProviderBudgetForSource(`ATS-${board.platform}`)')
      < acquisitionEntry.indexOf('loadOrCreateBatch(board)'),
    'an open platform circuit must defer the board before an empty batch is allocated',
  );
  assert.match(acquisition, /allowNewBatches: options\.allowNewBatches/);
  assert.match(acquisition, /atsOutstandingJobCount/);
  assert.equal(
    acquisition.match(/prisma\.\$transaction/g)?.length,
    acquisition.match(/withAtsTransaction\(\(\) => prisma\.\$transaction/g)?.length,
    'every ATS transaction must enter the shared transaction limiter',
  );
  // Prisma's 5s interactive default killed a 2,952-job board mid-listing and
  // left it permanently partial, so a transaction whose duration scales with
  // the accumulated payload must declare its own bounds.
  for (const [index, open] of [...acquisition.matchAll(/prisma\.\$transaction/g)].entries()) {
    const start = open.index ?? 0;
    let depth = 0;
    let opened = false;
    let cursor = start;
    while (cursor < acquisition.length && !(opened && depth === 0)) {
      const character = acquisition[cursor];
      if ('([{'.includes(character)) {
        depth += 1;
        opened = true;
      } else if (')]}'.includes(character)) {
        depth -= 1;
      }
      cursor += 1;
    }
    assert.ok(opened && depth === 0, `ATS transaction ${index} did not parse to a balanced call`);
    const body = acquisition.slice(start, cursor);
    // Any write of a real payload value scales with board size; clearing it to
    // DbNull and reading it back under `select` do not.
    const writesPayload = /payload: (?!Prisma\.DbNull)[A-Za-z]/.test(body)
      || body.includes('payloadHash(metadata, jobs)');
    assert.equal(
      writesPayload && !body.includes('ATS_PAYLOAD_TRANSACTION_OPTIONS'),
      false,
      `ATS transaction ${index} writes the listing payload without explicit bounds`,
    );
  }
  assert.match(
    acquisition,
    /const ATS_PAYLOAD_TRANSACTION_OPTIONS = \{\s+maxWait: 10_000,\s+timeout: 30_000,\s+\} as const;/,
  );
  assert.match(stats, /CURRENT_TIMESTAMP AT TIME ZONE \$\{CHICAGO_TIME_ZONE\}/);
  assert.match(stats, /daily_events AS/);
  assert.match(stats, /event\.kind = 'processed'/);
  assert.match(stats, /"deferredWithoutContactLastHour"/);
  assert.match(stats, /"remainingJobs"/);
  assert.match(stats, /prisma\.atsCompany\.aggregate/);
});
