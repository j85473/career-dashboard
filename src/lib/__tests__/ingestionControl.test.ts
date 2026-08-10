import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  countExternalIngestionOutcome,
  emptyExternalIngestionCounters,
} from '../jobIngestion';
import {
  buildIngestionTaskKey,
  buildPipelineEventKey,
  classifyIngestionTaskCompletion,
  deriveCatchUpWindow,
  evaluateProviderBudget,
  fairIngestionTaskOrder,
  GEO_LANES,
  ingestionReconciles,
  providerFailurePolicy,
  providerSuccessState,
  seedIngestionTaskSpecs,
  settleProviderState,
} from '../ingestionControl';
import {
  NATIVE_AE_TASK_DEFINITION,
  USAJOBS_TRAVEL_TASK_DEFINITION,
  canonicalIngestionTaskDefinitions,
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
  assert.match(route, /30 \* 60 \* 1000/);
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
  assert.ok(baseKeys.includes(buildIngestionTaskKey(NATIVE_AE_TASK_DEFINITION.spec)));

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
  const spec = NATIVE_AE_TASK_DEFINITION.spec;
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

test('seed command and pipeline consume the same catalog without executing providers', () => {
  const seedScript = readFileSync('scripts/seed_ingestion_tasks.ts', 'utf8');
  const pipelineRoute = readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  assert.match(seedScript, /canonicalIngestionTaskDefinitions/);
  assert.match(seedScript, /seedIngestionTaskSpecs/);
  assert.doesNotMatch(seedScript, /claimDueIngestionTask|ingestJobs|fetch\(|createNativeScoringRequest/);
  assert.match(packageJson, /"ingestion:seed-tasks"/);
  for (const builder of [
    'ROUTE_SOURCE_TASK_DEFINITIONS',
    'careerForceTaskDefinitions',
    'paidTaskDefinitions',
    'standardProviderTaskDefinitions',
    'atsPlatformTaskDefinition',
    'USAJOBS_TRAVEL_TASK_DEFINITION',
    'NATIVE_AE_TASK_DEFINITION',
  ]) assert.match(pipelineRoute, new RegExp(builder));
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
    /status: ingestionSourceRunStatus\(stats\),[\s\S]{0,700}?processingErrorCount: stats\.processingErrors,[\s\S]{0,500}?reconciled: ingestionReconciles/,
  );
});
