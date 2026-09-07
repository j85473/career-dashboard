import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  classifyIngestionTaskCompletion,
  ENRICHMENT_SHARING_PROVIDERS,
  evaluateProviderBudget,
  GLASSDOOR_BUDGET_PROVIDER,
  INDEED12_BUDGET_PROVIDER,
  providerRequestKind,
  searchAllowanceFor,
  SEARCH_RELEASE_SHARE,
} from '../ingestionControl';
import {
  buildJdEnrichmentDeferralUpdate,
  claimableJdDeferralWhere,
  CLEARED_JD_DEFERRALS,
  DEFAULT_JD_DEFERRAL_MS,
  isProviderRefusalWithoutRequest,
  MAX_JD_ENRICHMENT_DEFERRALS,
  planJdEnrichmentDeferral,
  ProviderCapacityRefusal,
} from '../jdEnrichmentDeferral';
import { indeedJobUrl, parseIndeedListing } from '../paidSearchResponse';

function source(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

test('a description call is never crowded out of the release by searches', () => {
  // 2026-09-07: 20 Glassdoor searches plus 48 ingest-time description calls
  // reached the hour's ceiling of 68, and the 69 already-filtered jobs waiting
  // on a description were refused. Search must stop first.
  const now = new Date(Date.UTC(2026, 8, 7, 15));
  const dailyLimit = 103;
  const released = Math.floor(dailyLimit * 16 / 24);
  const budget = (kind: 'search' | 'enrichment', dailyUsed: number) => evaluateProviderBudget({
    provider: GLASSDOOR_BUDGET_PROVIDER, state: 'closed', dailyLimit, dailyUsed, monthlyUsed: dailyUsed, kind, now,
  });

  const allowance = searchAllowanceFor(released);
  assert.ok(allowance < released, 'search must not be able to spend the whole release');
  assert.equal(budget('search', allowance - 1).allowed, true);
  assert.equal(budget('search', allowance).allowed, false);
  assert.equal(budget('search', allowance).reason, 'enrichment_budget');

  // Everything search leaves is still available to enrichment, up to the
  // ordinary paced ceiling. Reserved capacity is a floor for descriptions, not
  // an allocation that goes to waste.
  for (const used of [allowance, released - 1]) {
    assert.equal(budget('enrichment', used).allowed, true, `enrichment must proceed at ${used}`);
  }
  assert.equal(budget('enrichment', released).allowed, false);
  assert.equal(budget('enrichment', released).reason, 'paced_budget');
});

test('providers with no enrichment path keep their whole search allowance', () => {
  // JSearch's details endpoint is disabled by design and LinkedIn has none, so
  // holding back part of their release would cut search capacity by 40% for
  // calls that are never made.
  for (const provider of ['JSearch', 'LinkedIn']) {
    assert.equal(ENRICHMENT_SHARING_PROVIDERS.includes(provider), false, provider);
    let used = 0;
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 8, 6, hour));
      while (evaluateProviderBudget({
        provider, state: 'closed', dailyLimit: 25, dailyUsed: used, monthlyUsed: used, kind: 'search', now,
      }).allowed) used++;
    }
    assert.equal(used, 25, `${provider} search must still reach its whole daily allowance`);
  }
});

test('the whole daily allowance is still reachable, and search keeps its own floor', () => {
  for (const [provider, dailyLimit] of [[INDEED12_BUDGET_PROVIDER, 13], [GLASSDOOR_BUDGET_PROVIDER, 103]] as const) {
    let used = 0;
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 8, 6, hour));
      while (evaluateProviderBudget({
        provider, state: 'closed', dailyLimit, dailyUsed: used, monthlyUsed: used, kind: 'enrichment', now,
      }).allowed) used++;
    }
    assert.equal(used, dailyLimit, `${provider} must still release its whole unchanged allowance`);
    // A provider whose hourly release is a single request would otherwise
    // starve search completely; the floor keeps one for it.
    assert.equal(searchAllowanceFor(1), 1);
  }
  assert.ok(SEARCH_RELEASE_SHARE > 0 && SEARCH_RELEASE_SHARE < 1);
});

test('yielding the release to enrichment is a budget outcome, not a provider failure', () => {
  // Named so every existing "blocked by ...budget" matcher keeps working.
  // Classified as a failure it would open the provider's circuit and stop the
  // searches and descriptions that are working fine.
  const refusal = `${GLASSDOOR_BUDGET_PROVIDER} request blocked by enrichment_budget`;
  assert.equal(
    classifyIngestionTaskCompletion({ sourceStatuses: ['failed'], lastErrors: [refusal] }),
    'blocked_budget',
  );
});

test('the telemetry label, not the budget authority, says which kind of call this is', () => {
  assert.equal(providerRequestKind('Glassdoor Details'), 'enrichment');
  assert.equal(providerRequestKind('Indeed Details'), 'enrichment');
  assert.equal(providerRequestKind('Glassdoor (RapidAPI)'), 'search');
  assert.equal(providerRequestKind('Indeed'), 'search');
});

test('a refused reservation is told apart from a page that came back empty', () => {
  for (const message of [
    'Glassdoor Details request blocked by enrichment_budget',
    'Indeed Details request blocked by paced_budget',
    'Glassdoor Details request blocked by daily_budget',
    'Glassdoor Details request blocked by circuit_open',
  ]) {
    assert.equal(isProviderRefusalWithoutRequest(new Error(message)), true, message);
  }
  // Real provider outcomes must never be mistaken for a refusal, or a genuinely
  // dead posting would be deferred forever instead of terminalized.
  for (const message of [
    'Glassdoor Details HTTP 404',
    'Glassdoor Details returned no response',
    'JD recovery rejected: expired, closed, login, cookie, or portal shell.',
  ]) {
    assert.equal(isProviderRefusalWithoutRequest(new Error(message)), false, message);
  }
});

test('a call that was never made does not spend a recovery attempt, and is bounded', () => {
  const now = new Date('2026-09-07T15:23:00Z');
  const error = new Error('Glassdoor Details request blocked by enrichment_budget');
  const first = planJdEnrichmentDeferral(0, error, now);
  assert.equal(first.deferrals, 1);
  assert.equal(first.exhausted, false);

  const update = buildJdEnrichmentDeferralUpdate(first);
  assert.equal(update.scoringStatus, 'needs_jd');
  assert.equal(update.jdDeferrals, 1);
  assert.equal(update.jdBatchId, null);
  assert.ok(!('scoreAttempts' in update), 'a deferral must not touch the recovery attempt count');
  assert.ok(!('status' in update), 'a deferral must not change the job lifecycle');
  assert.match(update.scoreError, /deferred/i);

  // Waiting cannot go on forever.
  assert.equal(planJdEnrichmentDeferral(MAX_JD_ENRICHMENT_DEFERRALS - 1, error, now).exhausted, true);

  // A deferral has to cost elapsed time. The needs_jd queue is routinely empty,
  // so a job parked with no delay would be picked straight back up and burn its
  // whole budget in minutes — terminalizing during a shortage about to clear.
  assert.equal(first.deferredUntil.getTime(), now.getTime() + DEFAULT_JD_DEFERRAL_MS);
  assert.ok(update.jdDeferredUntil > now);

  // When the reservation names its own release time, that wins — but only when
  // it is further out. A retry time already in the past must not shorten the
  // wait to nothing.
  const nextHour = new Date('2026-09-07T17:00:00Z');
  assert.equal(
    planJdEnrichmentDeferral(0, new ProviderCapacityRefusal('blocked by paced_budget', nextHour), now)
      .deferredUntil.getTime(),
    nextHour.getTime(),
  );
  assert.equal(
    planJdEnrichmentDeferral(0, new ProviderCapacityRefusal('blocked by paced_budget', new Date('2026-01-01T00:00:00Z')), now)
      .deferredUntil.getTime(),
    now.getTime() + DEFAULT_JD_DEFERRAL_MS,
  );

  // And the claim query has to honour the window, not just the count.
  const where = claimableJdDeferralWhere(now);
  assert.deepEqual(where.jdDeferrals, { lt: MAX_JD_ENRICHMENT_DEFERRALS });
  assert.deepEqual(where.OR, [{ jdDeferredUntil: null }, { jdDeferredUntil: { lte: now } }]);

  // The count belongs to a waiting period, not to the job. A job that stops
  // waiting — either way — must be claimable again if it is ever requeued.
  assert.equal(CLEARED_JD_DEFERRALS.jdDeferrals, 0);
  const jdRecovery = source('src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts');
  const localScoring = source('src', 'lib', 'jobScoring.ts');
  for (const [name, text] of [['JD recovery', jdRecovery], ['local scoring', localScoring]] as const) {
    const exhausted = text.indexOf('deferral.exhausted');
    assert.ok(exhausted >= 0, `${name} must handle an exhausted deferral budget`);
    const clearedNearby = text.indexOf('CLEARED_JD_DEFERRALS', exhausted);
    assert.ok(
      clearedNearby > exhausted && clearedNearby - exhausted < 500,
      `${name} must clear the deferral count when it terminalizes`,
    );
  }
});

test('an Indeed job key yields a posting a human can actually open', () => {
  // Indeed's search response carries no url, which left 447 of 456 Indeed rows
  // in the dashboard with no link — including scored rows in the Inbox with
  // nothing to apply to. The key alone determines the URL; no request needed.
  assert.equal(indeedJobUrl('a5a66175c739a01f'), 'https://www.indeed.com/viewjob?jk=a5a66175c739a01f');
  assert.equal(indeedJobUrl('A5A66175C739A01F'), 'https://www.indeed.com/viewjob?jk=a5a66175c739a01f');
  assert.equal(indeedJobUrl('not-a-job-key'), '');

  const parsed = parseIndeedListing({ title: 'Territory Manager', id: 'a5a66175c739a01f' });
  assert.equal(parsed?.url, 'https://www.indeed.com/viewjob?jk=a5a66175c739a01f');

  // A url the provider does supply always wins over the derived one.
  const provided = parseIndeedListing({
    title: 'Territory Manager', id: 'a5a66175c739a01f', url: 'https://example.test/job',
  });
  assert.equal(provided?.url, 'https://example.test/job');
});

test('every description call the recovery pass makes is accounted for', () => {
  // Both call sites used to pass no provider control at all, so a refusal left
  // no pipeline event, no circuit health and no counter — the reason 69 refused
  // jobs looked like dead postings and nothing recorded that they were turned
  // away.
  const jdRecovery = source('src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts');
  const localScoring = source('src', 'lib', 'jobScoring.ts');
  const control = source('src', 'lib', 'jdRecoveryProviderControl.ts');

  assert.match(jdRecovery, /fetchGlassdoorJobDescription\(job, jdRecoveryProviderControl\(job\)\)/);
  assert.match(localScoring, /fetchGlassdoorJobDescription\(\s*job,\s*jdRecoveryProviderControl\(job\),\s*\)/);
  assert.match(control, /eventType: 'provider_request'/);
  assert.match(control, /recordProviderSuccess/);
  assert.match(control, /recordProviderFailure/);

  // A deferral must be chosen before the terminal path, in both places.
  for (const [name, text, terminal] of [
    ['JD recovery', jdRecovery, 'buildTerminalJdRecoveryUpdate'],
    ['local scoring', localScoring, 'buildTerminalJdRecoveryUpdate'],
  ] as const) {
    const deferralIndex = text.indexOf('isProviderRefusalWithoutRequest');
    assert.ok(deferralIndex >= 0, `${name} must recognise a refused reservation`);
    assert.ok(
      text.indexOf('planJdEnrichmentDeferral', deferralIndex) > deferralIndex,
      `${name} must defer a refused call`,
    );
    assert.ok(text.includes(terminal), `${name} keeps a terminal outcome for real failures`);
  }

  // The claim query must not keep handing back a job that has waited out its
  // deferral budget.
  assert.match(jdRecovery, /\.\.\.claimableJdDeferralWhere\(\)/);
  // The refusal must carry the provider's own release time to the deferral.
  assert.match(control, /new ProviderCapacityRefusal\(/);
  assert.match(control, /decision\.retryAt/);
});
