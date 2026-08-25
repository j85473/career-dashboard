import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  budgetedProviderAttempt,
  countExternalIngestionOutcome,
  emptyExternalIngestionCounters,
} from '../jobIngestion';
import {
  buildIngestionTaskKey,
  buildPipelineEventKey,
  classifyIngestionTaskCompletion,
  completionBasedNextRunAt,
  deterministicTaskJitterMs,
  deriveCatchUpWindow,
  evaluateProviderBudget,
  evaluateProviderAvailability,
  fairIngestionTaskOrder,
  GEO_LANES,
  ingestionReconciles,
  providerFailurePolicy,
  providerAvailabilityLookupSource,
  providerBudgetReservationInput,
  providerTaskAvailability,
  providerSuccessMayApply,
  providerSuccessState,
  reconcileIngestionTaskCatalog,
  reserveProviderBudgetForSource,
  seedIngestionTaskSpecs,
  settleProviderState,
  withProviderTransactionRetry,
} from '../ingestionControl';
import {
  USAJOBS_TRAVEL_TASK_DEFINITION,
  canonicalIngestionTaskDefinitions,
  planAtsPlatformBatches,
} from '../ingestionTaskCatalog';

test('durable task identity includes source, query family, geography, and mode', () => {
  const base = { source: 'SerpApi', queryFamily: 'channel_manager', searchQuery: 'channel manager', geoLane: 'msp_metro', ingestionMode: 'paid-title' };
  assert.equal(buildIngestionTaskKey(base), buildIngestionTaskKey({ ...base }));
  assert.notEqual(buildIngestionTaskKey(base), buildIngestionTaskKey({ ...base, source: 'Indeed' }));
  assert.notEqual(buildIngestionTaskKey(base), buildIngestionTaskKey({ ...base, queryFamily: 'partner_manager' }));
  assert.notEqual(buildIngestionTaskKey(base), buildIngestionTaskKey({ ...base, geoLane: 'us_remote' }));
  assert.notEqual(buildIngestionTaskKey(base), buildIngestionTaskKey({ ...base, ingestionMode: 'paid-travel' }));
});

test('canonical geography lanes are deterministic and include all target coverage', () => {
  assert.deepEqual(GEO_LANES.map((lane) => lane.id), ['msp_metro', 'minnesota', 'upper_midwest', 'us_remote']);
});

test('catch-up windows resume from successful watermark with overlap and a seven-day bound', () => {
  const now = new Date('2026-08-09T18:00:00.000Z');
  const recent = deriveCatchUpWindow(new Date('2026-08-09T12:00:00.000Z'), now);
  assert.equal(recent.windowStart.toISOString(), '2026-08-09T10:00:00.000Z');
  assert.equal(recent.isCatchUp, false);
  const old = deriveCatchUpWindow(new Date('2026-07-01T00:00:00.000Z'), now);
  assert.equal(old.windowStart.toISOString(), '2026-08-02T18:00:00.000Z');
  assert.equal(old.isCatchUp, true);
});

test('ingestion denominator reconciles only job outcomes, not provider failures', () => {
  assert.equal(ingestionReconciles({ seen: 10, inserted: 2, duplicates: 5, filtered: 2, processingErrors: 1, providerErrors: 3 }), true);
  assert.equal(ingestionReconciles({ seen: 10, inserted: 2, duplicates: 5, filtered: 2, processingErrors: 0, providerErrors: 0 }), false);
});

test('empty, circuit, budget, partial, and success task outcomes stay distinct', () => {
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: [] }), 'disabled');
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: [], circuitOpen: true }), 'blocked_circuit');
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: ['failed'], lastErrors: ['SerpApi request blocked by daily_budget'] }), 'blocked_budget');
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: ['success', 'failed'] }), 'partial');
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: ['idle'] }), 'succeeded');
});

test('provider budget decision blocks at exact daily and monthly caps', () => {
  assert.equal(evaluateProviderBudget({ state: 'closed', dailyLimit: 25, monthlyLimit: 1000, dailyUsed: 24, monthlyUsed: 999 }).allowed, true);
  assert.equal(evaluateProviderBudget({ state: 'closed', dailyLimit: 25, monthlyLimit: 1000, dailyUsed: 25, monthlyUsed: 999 }).reason, 'daily_budget');
  assert.equal(evaluateProviderBudget({ state: 'closed', dailyLimit: 25, monthlyLimit: 1000, dailyUsed: 1, monthlyUsed: 1000 }).reason, 'monthly_budget');
});

test('Indeed search and details resolve one quota authority and one override namespace', () => {
  const environment = {
    INDEED_DAILY_LIMIT: '99',
    INDEED_MONTHLY_LIMIT: '999',
    INDEED_DETAILS_DAILY_LIMIT: '88',
    INDEED_DETAILS_MONTHLY_LIMIT: '888',
    INDEED12_DAILY_LIMIT: '7',
    INDEED12_MONTHLY_LIMIT: '70',
  };
  assert.deepEqual(
    providerBudgetReservationInput('Indeed', { dailyLimit: 1, monthlyLimit: 2 }, environment),
    { provider: 'Indeed12', dailyLimit: 7, monthlyLimit: 70 },
  );
  assert.deepEqual(
    providerBudgetReservationInput('Indeed Details', { dailyLimit: 3, monthlyLimit: 4 }, environment),
    { provider: 'Indeed12', dailyLimit: 7, monthlyLimit: 70 },
  );
  assert.deepEqual(
    providerBudgetReservationInput('Indeed', {}, {}),
    { provider: 'Indeed12', dailyLimit: 13, monthlyLimit: 400 },
  );
});

test('Indeed search and detail attempts consume one shared ledger without double charging', async () => {
  let dailyUsed = 0;
  let monthlyUsed = 0;
  let upstreamRequests = 0;
  const telemetrySources: string[] = [];
  const reservations: Array<{ provider: string; dailyLimit?: number | null; monthlyLimit?: number | null }> = [];
  const reserve = async (input: { provider: string; dailyLimit?: number | null; monthlyLimit?: number | null }) => {
    reservations.push(input);
    const decision = evaluateProviderBudget({
      state: 'closed',
      ...input,
      dailyUsed,
      monthlyUsed,
      now: new Date('2026-08-24T12:00:00.000Z'),
    });
    if (decision.allowed) {
      dailyUsed++;
      monthlyUsed++;
    }
    return decision;
  };
  const beforeRequest = async (telemetrySource: string) => {
    telemetrySources.push(telemetrySource);
    const decision = await reserveProviderBudgetForSource(telemetrySource, {}, {
      environment: { INDEED12_DAILY_LIMIT: '2', INDEED12_MONTHLY_LIMIT: '400' },
      reserve,
    });
    if (!decision.allowed) throw new Error(`${telemetrySource} request blocked by ${decision.reason}`);
  };
  const request = async () => {
    upstreamRequests++;
    return 'ok';
  };

  await budgetedProviderAttempt('Indeed', beforeRequest, request);
  await budgetedProviderAttempt('Indeed Details', beforeRequest, request);
  await assert.rejects(
    budgetedProviderAttempt('Indeed', beforeRequest, request),
    /Indeed request blocked by daily_budget/,
  );
  await assert.rejects(
    budgetedProviderAttempt('Indeed Details', beforeRequest, request),
    /Indeed Details request blocked by daily_budget/,
  );

  assert.deepEqual(telemetrySources, ['Indeed', 'Indeed Details', 'Indeed', 'Indeed Details']);
  assert.equal(reservations.length, 4);
  assert.equal(reservations.every((input) => input.provider === 'Indeed12'), true);
  assert.equal(dailyUsed, 2);
  assert.equal(monthlyUsed, 2);
  assert.equal(upstreamRequests, 2);
});

test('Indeed task claims keep failure circuits distinct from the shared budget authority', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const closed = {
    state: 'closed',
    openUntil: null,
    dailyUsed: 0,
    monthlyUsed: 0,
    budgetDay: '2026-08-24',
    budgetMonth: '2026-08',
  };
  const sharedBudgetBlocked = providerTaskAvailability(
    'Indeed',
    { ...closed, dailyLimit: 1, dailyUsed: 99 },
    { ...closed, dailyLimit: 2, monthlyLimit: 400, dailyUsed: 2 },
    now,
  );
  assert.equal(sharedBudgetBlocked?.reason, 'daily_budget');
  assert.equal(sharedBudgetBlocked?.retryAt?.toISOString(), '2026-08-25T00:00:00.000Z');

  const failureCircuitRetry = new Date('2026-08-24T18:00:00.000Z');
  const failureCircuitBlocked = providerTaskAvailability(
    'Indeed',
    { ...closed, state: 'open', openUntil: failureCircuitRetry },
    { ...closed, dailyLimit: 13, monthlyLimit: 400 },
    now,
  );
  assert.equal(failureCircuitBlocked?.reason, 'circuit_open');
  assert.equal(failureCircuitBlocked?.retryAt, failureCircuitRetry);

  const ordinaryProviderBlocked = providerTaskAvailability(
    'SerpApi',
    { ...closed, dailyLimit: 25, dailyUsed: 25 },
    { ...closed, dailyLimit: 25, dailyUsed: 25 },
    now,
  );
  assert.equal(ordinaryProviderBlocked?.reason, 'daily_budget');
  assert.equal(providerTaskAvailability('SerpApi', closed, closed, now), null);
});

test('blocked-budget completion reads Indeed12 while failure circuits keep the Indeed label', () => {
  assert.equal(providerAvailabilityLookupSource('Indeed', 'blocked_budget'), 'Indeed12');
  assert.equal(providerAvailabilityLookupSource('Indeed', 'blocked_circuit'), 'Indeed');
  assert.equal(providerAvailabilityLookupSource('SerpApi', 'blocked_budget'), 'SerpApi');
});

test('completion scheduling anchors cadence and bounded retries to actual finish', () => {
  const finishedAt = new Date('2026-08-14T18:00:00.000Z');
  const success = completionBasedNextRunAt({ taskKey: 'task', status: 'succeeded', finishedAt, cadenceMs: 15 * 60_000 });
  assert.equal(success.toISOString(), '2026-08-14T18:15:00.000Z');
  assert.ok(success >= finishedAt);
  assert.equal(completionBasedNextRunAt({ taskKey: 'task', status: 'failed', finishedAt, cadenceMs: 86_400_000, retryDelayMs: 120_000 }).toISOString(), '2026-08-14T18:02:00.000Z');
  assert.equal(completionBasedNextRunAt({ taskKey: 'task', status: 'partial', finishedAt, cadenceMs: 86_400_000, retryDelayMs: 60_000 }).toISOString(), '2026-08-14T18:01:00.000Z');
  assert.equal(completionBasedNextRunAt({ taskKey: 'task', status: 'partial', finishedAt, cadenceMs: 86_400_000, continuationDelayMs: 30_000 }).toISOString(), '2026-08-14T18:00:30.000Z');
});

test('provider eligibility uses exact circuit and UTC budget resets plus deterministic jitter', () => {
  const now = new Date('2026-08-14T23:30:00.000Z');
  const circuitRetry = new Date('2026-08-15T03:00:00.000Z');
  assert.equal(evaluateProviderAvailability({ state: 'open', openUntil: circuitRetry, dailyUsed: 0, monthlyUsed: 0, now }).retryAt, circuitRetry);
  assert.equal(evaluateProviderAvailability({ state: 'closed', dailyLimit: 1, dailyUsed: 1, monthlyUsed: 0, budgetDay: '2026-08-14', now }).retryAt?.toISOString(), '2026-08-15T00:00:00.000Z');
  assert.equal(evaluateProviderAvailability({ state: 'closed', monthlyLimit: 1, dailyUsed: 0, monthlyUsed: 1, budgetMonth: '2026-08', now }).retryAt?.toISOString(), '2026-09-01T00:00:00.000Z');
  const combined = evaluateProviderAvailability({ state: 'open', openUntil: circuitRetry, dailyLimit: 1, monthlyLimit: 1, dailyUsed: 1, monthlyUsed: 1, budgetDay: '2026-08-14', budgetMonth: '2026-08', now });
  assert.equal(combined.reason, 'monthly_budget');
  assert.equal(combined.retryAt?.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(deterministicTaskJitterMs('same-task'), deterministicTaskJitterMs('same-task'));
  assert.notEqual(deterministicTaskJitterMs('same-task'), deterministicTaskJitterMs('other-task'));
});

test('provider transaction retry is bounded to P2034 and reports exhaustion', async () => {
  let attempts = 0;
  const result = await withProviderTransactionRetry(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('serialization'), { code: 'P2034' });
    return 'ok';
  }, { sleep: async () => {}, random: () => 0 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  await assert.rejects(() => withProviderTransactionRetry(async () => {
    throw Object.assign(new Error('terminal serialization'), { code: 'P2034' });
  }, { maxAttempts: 2, sleep: async () => {}, random: () => 0 }), /terminal serialization/);
  await assert.rejects(() => withProviderTransactionRetry(async () => {
    throw Object.assign(new Error('not retryable'), { code: 'P2002' });
  }, { sleep: async () => {} }), /not retryable/);
});

test('an older provider success cannot close a newer failure', () => {
  assert.equal(providerSuccessMayApply(new Date('2026-08-14T18:01:00Z'), new Date('2026-08-14T18:00:00Z')), false);
  assert.equal(providerSuccessMayApply(new Date('2026-08-14T18:00:00Z'), new Date('2026-08-14T18:00:00Z')), false);
  assert.equal(providerSuccessMayApply(new Date('2026-08-14T17:59:00Z'), new Date('2026-08-14T18:00:00Z')), true);
});

test('hard failures open immediately while transient failures require a threshold and success resets', () => {
  const now = new Date('2026-08-09T18:00:00.000Z');
  assert.equal(providerFailurePolicy('endpoint_unavailable', 0, now).state, 'open');
  assert.equal(providerFailurePolicy('timeout', 0, now).state, 'closed');
  assert.equal(providerFailurePolicy('provider_error', 1, now).state, 'closed');
  assert.equal(providerFailurePolicy('provider_error', 2, now).state, 'open');
  assert.deepEqual(providerSuccessState(now), {
    state: 'closed', openUntil: null, consecutiveFailures: 0, lastError: null, lastSuccessAt: now,
  });
});

test('provider-state settlement waits for delayed incident persistence', async () => {
  let persisted = false;
  const delayed = new Promise<void>((resolve) => {
    setTimeout(() => { persisted = true; resolve(); }, 10);
  });
  await settleProviderState([delayed]);
  assert.equal(persisted, true);
});

test('immutable pipeline event identity is retry-stable but run-specific', () => {
  const input = { eventType: 'ingested' as const, jobId: 'job-1', taskId: 'task-1', source: 'SerpApi', sourceId: 'source-1' };
  assert.equal(buildPipelineEventKey(input), buildPipelineEventKey({ ...input }));
  assert.notEqual(buildPipelineEventKey({ ...input, identityParts: ['window-a'] }), buildPipelineEventKey({ ...input, identityParts: ['window-b'] }));
});

test('durable task nextRunAt is authoritative over legacy portfolio clocks', () => {
  const route = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  assert.doesNotMatch(route, /now\s*-\s*state\.lastRunPaidApis\s*>/);
  assert.doesNotMatch(route, /now\s*-\s*state\.lastRunCareerforce\s*>/);
  assert.doesNotMatch(route, /now\s*-\s*state\.lastRunStandard\s*>/);
  assert.doesNotMatch(route, /now\s*-\s*state\.lastRunAts\s*>/);
  assert.match(route, /claimDueIngestionTask\(spec\)/);
  assert.doesNotMatch(route, /taskNextRunAt|const nextRunAt = new Date\(Date\.now\(\) \+ intervalMs\)/);
  assert.match(route, /taskCadenceMs/);
});

test('two-day low-budget ordering advances every lane and query class without fixed-prefix starvation', () => {
  const lanes = ['msp_metro', 'minnesota', 'upper_midwest', 'us_remote'];
  const classes = ['travel_', '', 'description_'];
  const due = new Date('2026-08-09T00:00:00.000Z');
  const rows = classes.flatMap((prefix) => lanes.flatMap((geoLane) =>
    Array.from({ length: 5 }, (_, index) => ({
      taskKey: `${prefix || 'title_'}${geoLane}_${index}`,
      queryFamily: `${prefix}query_${index}`,
      geoLane,
      nextRunAt: due,
      lastCompletedAt: null,
    }))));
  const dayOne = fairIngestionTaskOrder(rows, new Date('2026-08-09T12:00:00.000Z')).slice(0, 12);
  const dayTwo = fairIngestionTaskOrder(rows, new Date('2026-08-10T12:00:00.000Z')).slice(0, 12);
  const coverage = (sample: typeof rows) => new Set(sample.map((row) => `${row.queryFamily.startsWith('travel_') ? 'travel' : row.queryFamily.startsWith('description_') ? 'description' : 'title'}:${row.geoLane}`));
  assert.equal(coverage(dayOne).size, 12);
  assert.equal(coverage(dayTwo).size, 12);
  assert.notDeepEqual(dayOne.map((row) => row.taskKey), dayTwo.map((row) => row.taskKey));
});

test('an older budget-blocked task runs before yesterday successful tasks after reset', () => {
  const ordered = fairIngestionTaskOrder([
    { taskKey: 'blocked', queryFamily: 'description_partner', geoLane: 'us_remote', nextRunAt: new Date('2026-08-08T01:00:00Z'), lastCompletedAt: null },
    { taskKey: 'successful', queryFamily: 'channel_manager', geoLane: 'msp_metro', nextRunAt: new Date('2026-08-09T01:00:00Z'), lastCompletedAt: new Date('2026-08-08T01:00:00Z') },
  ], new Date('2026-08-09T12:00:00Z'));
  assert.equal(ordered[0]?.taskKey, 'blocked');
});

test('fair ATS planning gives Workable a bounded turn beside 10,000 Workday boards', () => {
  assert.deepEqual(planAtsPlatformBatches(
    { workday: 10_000, workable: 1 },
    ['workday', 'workable'],
    25,
  ), [
    { platform: 'workday', selectedCount: 25, remainingDueCount: 9_975 },
    { platform: 'workable', selectedCount: 1, remainingDueCount: 0 },
  ]);
  const route = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  assert.match(route, /planAtsPlatformBatches/);
  assert.match(route, /for \(const turn of turns\)/);
  assert.match(route, /taskContinuationDelayMs/);
  assert.match(route, /WORKDAY_DEFERRAL_CANARY_BOARD_LIMIT/);
  assert.match(route, /needsJdBacklog < WORKDAY_NEEDS_JD_BACKLOG_LIMIT/);
  assert.match(route, /Exact v2 fallback while the v3 feature gate is off/);
  assert.match(route, /take: 1_000/);
});

test('bounded ATS execution preserves progress and defers Workday details to needs_jd', () => {
  const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  assert.match(ingestion, /atsBatchWallClockMs/);
  assert.match(ingestion, /AbortSignal\.any\(\[signal, atsDeadlineController\.signal\]\)/);
  assert.match(ingestion, /throwIfAtsInterrupted\(\)/);
  assert.match(ingestion, /phase: ingestionInterruptionReason \? 'interrupted' : 'finished'/);
  assert.match(ingestion, /if \(ingestionInterruptionReason\) taskStatus = 'partial'/);
  assert.equal((ingestion.match(/phase: ingestionInterruptionReason \? 'interrupted' : 'finished'/g) || []).length, 3);
  assert.match(ingestion, /atsProgress && boardAttemptCompleted/);
  assert.match(ingestion, /selectedCount/);
  assert.match(ingestion, /completedCount/);
  assert.match(ingestion, /remainingDueCount/);
  assert.match(ingestion, /currentBoard/);
  // The Workday detail fetch is now gated on the free title filter rather than
  // on needs_jd depth. See workdayDetailGate.test.ts for why the old backlog
  // signal could never re-enable it.
  assert.match(ingestion, /board\.platform === "workday" && job\.externalPath && workdayDetailWorthFetching/);
  assert.match(ingestion, /workdayCompany = workdayHiringOrganizationName\(singleJobData\.hiringOrganization\)/);
  assert.match(ingestion, /workdayLocation = workdayDetailLocation\(singleJobData\.jobPostingInfo\)/);
  assert.match(ingestion, /company = workdayCompany \|\| workdayBoardCompanyFallback\(board\.slug\)/);
  assert.match(ingestion, /locationStr = workdayLocation\s*\?\? resolveWorkdayPlaceholderLocation/);
  assert.match(
    ingestion,
    /scoringStatus: lifecycleProtectedSource[\s\S]*?: enrichedPostingClosed \? 'skipped' : needsJd \? 'needs_jd' : 'queued'/,
  );
  assert.doesNotMatch(readFileSync('src/lib/jobFiltering.ts', 'utf8'), /job\.description/);
});

test('external route outcomes reconcile one observed job to one outcome', () => {
  const counters = emptyExternalIngestionCounters();
  countExternalIngestionOutcome(counters, 'inserted');
  countExternalIngestionOutcome(counters, 'duplicate');
  countExternalIngestionOutcome(counters, 'filtered');
  countExternalIngestionOutcome(counters, 'processing_error');
  assert.deepEqual(counters, {
    seen: 4,
    inserted: 1,
    duplicates: 1,
    filtered: 1,
    processingErrors: 1,
    providerErrors: 0,
    requests: 0,
  });
  assert.equal(ingestionReconciles(counters), true);
});

test('legacy source routes use shared pending-A/E ingestion or explicit disabled evidence', () => {
  const routeFiles = [
    'src/app/api/pipeline/apify/route.ts',
    'src/app/api/pipeline/dice/route.ts',
    'src/app/api/pipeline/reddit/route.ts',
    'src/app/api/pipeline/hackernews/route.ts',
    'src/app/api/pipeline/github/route.ts',
  ];
  for (const file of routeFiles) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /ingestExternalJob\([\s\S]*?,\s*['"]inbox['"]\s*\)/);
    assert.match(source, /persistExternalIngestionSourceRun/);
    assert.match(source, /ingestionCounters/);
  }
  const apify = readFileSync(routeFiles[0], 'utf8');
  assert.match(apify, /ingestExternalJob/);
  assert.doesNotMatch(apify, /prisma\.job\.(?:create|upsert)/);
  const dice = readFileSync(routeFiles[1], 'utf8');
  assert.match(dice, /ingestExternalJob/);
});

test('external job routes are claimed by durable source tasks, not polled every loop', () => {
  const route = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  assert.match(route, /const routeSources = ROUTE_SOURCE_TASK_DEFINITIONS\.map/);
  assert.match(route, /orderDueIngestionTaskSpecs\(routeSources\.map/);
  assert.match(route, /runDurableRouteSource\(/);
  assert.doesNotMatch(route, /runRouteStep\(['"](?:Apify job sync|Dice sync|Reddit sync|Hacker News sync|GitHub sync)['"]/);
});

test('CareerOneStop remains a bounded opt-in canary instead of a portfolio sweep', () => {
  const route = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  assert.match(route, /CAREERONESTOP_USER_ID\s*&&\s*process\.env\.CAREERONESTOP_API_TOKEN/);
  assert.match(route, /runStandardProvider\('CareerOneStop', \['channel sales'\], careerOneStopCanaryLane, 24 \* 60 \* 60 \* 1000\)/);
  assert.doesNotMatch(route, /runStandardProvider\('CareerOneStop', primaryQueries, GEO_LANES/);
});

test('canonical task catalog is unique, complete, and configuration-aware', () => {
  const base = canonicalIngestionTaskDefinitions();
  const baseKeys = base.map((definition) => buildIngestionTaskKey(definition.spec));
  assert.equal(new Set(baseKeys).size, base.length);
  assert.ok(base.length > 500, 'the complete paid/query/geo portfolio must be seeded, not a token row');
  assert.equal(base.some((definition) => definition.spec.source === 'CareerOneStop'), false);
  assert.equal(base.some((definition) => definition.spec.source === 'Adzuna'), false);
  assert.equal(base.some((definition) => definition.spec.source === 'USAJOBS'), false);
  assert.equal(base.some((definition) => definition.spec.source === 'native-ae-request'), false);

  const configured = canonicalIngestionTaskDefinitions({
    includeCareerOneStop: true,
    includeAdzuna: true,
    includeUsaJobs: true,
    atsPlatforms: ['workday', 'greenhouse', 'workday'],
  });
  const configuredKeys = configured.map((definition) => buildIngestionTaskKey(definition.spec));
  assert.equal(new Set(configuredKeys).size, configured.length);
  assert.equal(configured.filter((definition) => definition.spec.source === 'CareerOneStop').length, 1);
  assert.ok(configuredKeys.includes(buildIngestionTaskKey(USAJOBS_TRAVEL_TASK_DEFINITION.spec)));
  assert.equal(configured.filter((definition) => definition.spec.source.startsWith('ATS-')).length, 2);
});

test('scheduler v3 migration is additive and lifecycle-indexed', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const migration = readFileSync('prisma/migrations/20260814200000_ingestion_scheduler_v3_lifecycle/migration.sql', 'utf8');
  assert.match(schema, /taskKind\s+String\s+@default\("search"\)/);
  assert.match(schema, /lifecycleStatus\s+String\s+@default\("active"\)/);
  assert.match(schema, /@@index\(\[taskKind, lifecycleStatus, status, nextRunAt\]\)/);
  assert.match(migration, /ADD COLUMN "taskKind"/);
  assert.match(migration, /ADD COLUMN "lifecycleStatus"/);
  assert.match(migration, /CREATE INDEX "IngestionTask_taskKind_lifecycleStatus_status_nextRunAt_idx"/);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|TRUNCATE)\b/i);
});

test('seed-only helper upserts definitions without claiming or resetting runtime state', async () => {
  type UpsertArgs = {
    where: { taskKey: string };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  };
  const calls: UpsertArgs[] = [];
  const fakeClient = {
    ingestionTask: {
      async upsert(args: UpsertArgs) {
        calls.push(args);
        return { id: `id-${args.where.taskKey}`, taskKey: args.where.taskKey };
      },
    },
  };
  const spec = USAJOBS_TRAVEL_TASK_DEFINITION.spec;
  const now = new Date('2026-08-09T20:00:00.000Z');
  const seeded = await seedIngestionTaskSpecs([spec, { ...spec }], {
    now,
    client: fakeClient as never,
  });
  assert.equal(seeded.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].update).sort(), [
    'geoLane', 'ingestionMode', 'queryFamily', 'searchQuery', 'source',
  ]);
  assert.equal(calls[0].create.nextRunAt, now);
  for (const forbidden of ['leaseToken', 'leaseOwner', 'status', 'watermarkAt', 'cursor', 'requestCount', 'seenCount']) {
    assert.equal(forbidden in calls[0].update, false, `seed update must preserve ${forbidden}`);
  }
});

test('catalog reconciliation previews retirement/reactivation, refuses leases, and is idempotent', async () => {
  const spec = USAJOBS_TRAVEL_TASK_DEFINITION.spec;
  const expectedKey = buildIngestionTaskKey(spec);
  type Row = {
    id: string; taskKey: string; source: string; status: string; taskKind: string;
    lifecycleStatus: string; leaseToken: string | null; retiredAt?: Date | null;
  };
  const rows: Row[] = [
    { id: 'expected', taskKey: expectedKey, source: spec.source, status: 'succeeded', taskKind: 'search', lifecycleStatus: 'retired', leaseToken: null },
    { id: 'old', taskKey: 'old-task', source: 'Old', status: 'succeeded', taskKind: 'search', lifecycleStatus: 'active', leaseToken: null },
    { id: 'leased', taskKey: 'leased-old', source: 'Old', status: 'running', taskKind: 'search', lifecycleStatus: 'active', leaseToken: 'lease' },
    { id: 'sentinel', taskKey: 'scheduler:v2:legacy-orchestration', source: 'scheduler', status: 'succeeded', taskKind: 'search', lifecycleStatus: 'active', leaseToken: null },
  ];
  let upsertCalls = 0;
  const fakeClient = {
    ingestionTask: {
      async findMany() { return rows.map((row) => ({ ...row })); },
      async upsert(args: { where: { taskKey: string }; update: Record<string, unknown>; create: Record<string, unknown> }) {
        upsertCalls++;
        const row = rows.find((candidate) => candidate.taskKey === args.where.taskKey);
        if (row) Object.assign(row, args.update);
        else rows.push({ ...(args.create as Row), id: `id-${args.where.taskKey}`, status: 'queued', leaseToken: null });
        return row || rows.at(-1);
      },
      async updateMany(args: { where: { taskKey?: { in: string[] } }; data: Record<string, unknown> }) {
        const keys = new Set(args.where.taskKey?.in || []);
        let count = 0;
        for (const row of rows) if (keys.has(row.taskKey) && row.leaseToken === null && row.status !== 'running') {
          Object.assign(row, args.data); count++;
        }
        return { count };
      },
    },
  };
  const preview = await reconcileIngestionTaskCatalog([spec], { client: fakeClient as never });
  assert.deepEqual(preview.reactivations, [expectedKey]);
  assert.deepEqual(preview.retirements, ['leased-old', 'old-task']);
  assert.deepEqual(preview.orchestration, ['scheduler:v2:legacy-orchestration']);
  assert.deepEqual(preview.leasedConflicts, ['leased-old']);
  await assert.rejects(() => reconcileIngestionTaskCatalog([spec], { apply: true, client: fakeClient as never }), /leased\/running/);
  const leased = rows.find((row) => row.taskKey === 'leased-old')!;
  leased.leaseToken = null;
  leased.status = 'succeeded';
  await reconcileIngestionTaskCatalog([spec], { apply: true, client: fakeClient as never });
  assert.equal(upsertCalls, 1);
  const expected = rows.find((row) => row.taskKey === expectedKey)!;
  expected.leaseToken = 'active-lease';
  expected.status = 'running';
  await reconcileIngestionTaskCatalog([spec], { apply: true, client: fakeClient as never });
  assert.equal(upsertCalls, 1, 'an unchanged leased canonical task must not be written');
  const second = await reconcileIngestionTaskCatalog([spec], { client: fakeClient as never });
  assert.equal(second.additions.length + second.reactivations.length + second.retirements.length + second.orchestration.length, 0);
  assert.equal(rows.find((row) => row.taskKey === expectedKey)?.lifecycleStatus, 'active');
  assert.equal(rows.find((row) => row.taskKey === 'old-task')?.lifecycleStatus, 'retired');
  assert.equal(rows.find((row) => row.taskKey === 'scheduler:v2:legacy-orchestration')?.taskKind, 'orchestration');
});

test('seed command and pipeline consume the same catalog without executing providers', () => {
  const seedScript = readFileSync('scripts/seed_ingestion_tasks.ts', 'utf8');
  const pipelineRoute = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  assert.match(seedScript, /canonicalIngestionTaskDefinitions/);
  assert.match(seedScript, /reconcileIngestionTaskCatalog/);
  assert.match(seedScript, /--dry-run/);
  assert.match(seedScript, /--apply/);
  assert.doesNotMatch(seedScript, /claimDueIngestionTask|ingestJobs|fetch\(|createNativeScoringRequest/);
  assert.match(packageJson, /"ingestion:seed-tasks"/);
  for (const builder of [
    'ROUTE_SOURCE_TASK_DEFINITIONS',
    'careerForceTaskDefinitions',
    'paidTaskDefinitions',
    'standardProviderTaskDefinitions',
    'atsPlatformTaskDefinition',
    'USAJOBS_TRAVEL_TASK_DEFINITION',
  ]) assert.match(pipelineRoute, new RegExp(builder));
  assert.doesNotMatch(pipelineRoute, /NATIVE_AE_TASK_DEFINITION|createNativeScoringRequest/);
});

test('every rollout-era source-run writer carries explicit reconciliation evidence', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const sourceRunWrites = [...source.matchAll(/prisma\.ingestionSourceRun\.(?:create|update)\(/g)];
  assert.equal(sourceRunWrites.length, 4, 'new source-run write paths require an explicit reconciliation audit');
  assert.match(
    source,
    /persistExternalIngestionSourceRun[\s\S]*?ingestionSourceRun\.create\(\{[\s\S]*?reconciled: true,[\s\S]*?checkpoint: \{ phase: 'finished'/,
  );
  assert.match(
    source,
    /status: 'running',[\s\S]{0,700}?checkpoint: \{ runIdentity, phase: 'started' \},[\s\S]{0,700}?reconciled: true/,
  );
  assert.match(
    source,
    /status: 'running',[\s\S]{0,500}?processingErrorCount: stats\.processingErrors,[\s\S]{0,300}?reconciled,/,
  );
  assert.match(
    source,
    /const sourceStatus = ingestionInterruptionReason \? 'partial' : ingestionSourceRunStatus\(stats\);[\s\S]{0,500}?status: sourceStatus,[\s\S]{0,700}?processingErrorCount: stats\.processingErrors,[\s\S]{0,500}?reconciled: ingestionReconciles/,
  );
});

test('browser scrapers are process-group bounded and stop between durable CareerForce claims', () => {
  const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const route = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  const careerForce = readFileSync('src/scripts/careerForceScraper.ts', 'utf8');
  const dejobs = readFileSync('src/scripts/dejobsScraper.ts', 'utf8');
  assert.equal((ingestion.match(/detached: process\.platform !== 'win32'/g) || []).length, 2);
  assert.equal((ingestion.match(/signalChildProcessGroup\(child, 'SIGTERM'\)/g) || []).length, 2);
  assert.equal((ingestion.match(/signalChildProcessGroup\(child, 'SIGKILL'\)/g) || []).length, 2);
  assert.doesNotMatch(ingestion, /spawn\('npx'/);
  assert.match(route, /for \(const definition of careerForceTaskDefinitions\(\)\) \{\s+if \(ac\.signal\.aborted \|\| await pipelineStopRequested\(\)\) break;/);
  for (const scraper of [careerForce, dejobs]) {
    assert.match(scraper, /process\.once\('SIGTERM'/);
    assert.match(scraper, /closing browser before exit/);
  }
});

test('manual stops pause cron until an explicit manual run while deployments only quiesce', () => {
  const runRoute = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  const stopRoute = readFileSync('src/app/api/pipeline/stop/route.ts', 'utf8');
  const cron = readFileSync('scripts/cron/http.ts', 'utf8');
  const deploy = readFileSync('scripts/deploy.sh', 'utf8');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const pipelineState = readFileSync('src/lib/pipelineState.ts', 'utf8');
  assert.match(schema, /schedulePaused\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /pausedUntil\s+DateTime\?/);
  assert.match(stopRoute, /const pauseSchedule = mode !== 'quiesce'/);
  assert.match(stopRoute, /schedulePaused: pauseSchedule/);
  assert.match(runRoute, /requireScheduleEnabled: scheduledRequest/);
  // A manual run is the explicit resume and clears the expiry with the flag.
  assert.match(runRoute, /update: \{ schedulePaused: false, pausedUntil: null \}/);
  assert.match(runRoute, /currentStep: 'Paused'/);
  assert.match(cron, /startResult\.paused === true/);
  assert.match(deploy, /api\/pipeline\/stop\?mode=quiesce/);
  // A pause now lapses so a forgotten Stop cannot hold ingestion off forever,
  // while an explicitly indefinite pause still waits for a human.
  assert.match(stopRoute, /mode === 'pause'\s*\n?\s*\?\s*new Date\(Date\.now\(\) \+ PIPELINE_PAUSE_DEFAULT_MS\)/);
  assert.match(stopRoute, /requested !== 'quiesce' && requested !== 'indefinite'/);
  assert.match(pipelineState, /\{ OR: \[\{ schedulePaused: false \}, \{ pausedUntil: \{ lte: new Date\(now\) \} \}\] \}/);
});
