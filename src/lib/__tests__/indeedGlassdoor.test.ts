import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithKeyRotation, resetKeyCooldowns } from '../apiFallback';
import { hashApiKey, type KeyCooldownStore } from '../apiKeyCooldownStore';
import { evaluateProviderBudget, providerBudgetReservationInput, providerTaskAvailability, reserveProviderBudgetForSource } from '../ingestionControl';
import { parseGlassdoorListing } from '../jobIngestion';
import { paidSearchAgeParams, parseIndeedListing, readPaidSearchResponse, type PaidSearchDiagnostics } from '../paidSearchResponse';

test('Glassdoor searches and descriptions use the same existing limits despite generic caller defaults', async () => {
  const calls: unknown[] = [];
  for (const source of ['Glassdoor (RapidAPI)', 'Glassdoor Details']) {
    assert.deepEqual(providerBudgetReservationInput(source, { dailyLimit: 25 }, {}),
      { provider: 'Glassdoor (RapidAPI)', dailyLimit: 103, monthlyLimit: 3200 });
    await reserveProviderBudgetForSource(source, { dailyLimit: 25 }, { environment: {}, reserve: async (input) => {
      calls.push(input); return { allowed: true, dailyUsed: calls.length, monthlyUsed: calls.length };
    } });
    assert.deepEqual(providerBudgetReservationInput(source, { dailyLimit: 25 }, {
      GLASSDOOR_RAPIDAPI__DAILY_LIMIT: '50', GLASSDOOR_RAPIDAPI__MONTHLY_LIMIT: '1500',
    }), { provider: 'Glassdoor (RapidAPI)', dailyLimit: 50, monthlyLimit: 1500 });
  }
  assert.equal(calls.length, 2);
  // One ledger, two kinds. The limits must stay identical — that is what stops
  // a description caller inventing its own quota — while the kind has to differ,
  // because the search share is what keeps a description call from being
  // crowded out of the release it is waiting for.
  const [searchCall, detailCall] = calls as Array<Record<string, unknown>>;
  assert.deepEqual(
    { ...searchCall, kind: undefined },
    { ...detailCall, kind: undefined },
  );
  assert.equal(searchCall.kind, 'search');
  assert.equal(detailCall.kind, 'enrichment');
});

test('Indeed and Glassdoor release their whole unchanged daily allowances over the day', () => {
  for (const [provider, dailyLimit] of [['Indeed12', 13], ['Glassdoor (RapidAPI)', 103]] as const) {
    let used = 0;
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 8, 6, hour));
      while (evaluateProviderBudget({ provider, state: 'closed', dailyLimit, dailyUsed: used, monthlyUsed: used, now }).allowed) used++;
      assert.equal(used, Math.floor(dailyLimit * (hour + 1) / 24));
      assert.ok(evaluateProviderBudget({ provider, state: 'closed', dailyLimit, dailyUsed: used, monthlyUsed: used, now }).retryAt!.getTime() > now.getTime());
    }
    assert.equal(used, dailyLimit);
  }
  const now = new Date('2026-09-06T12:00:00Z');
  const record = { state: 'closed', dailyUsed: 7, dailyLimit: 13, monthlyUsed: 78, monthlyLimit: 400, budgetDay: '2026-09-06', budgetMonth: '2026-09' };
  assert.equal(providerTaskAvailability('Indeed', { ...record, dailyUsed: 999 }, record, now)?.reason, 'paced_budget');
  assert.equal(providerTaskAvailability('Indeed', record, { ...record, monthlyUsed: 400 }, now)?.reason, 'monthly_budget');
});

test('Indeed shares the longest historic cooldown across search, details and restart', async () => {
  resetKeyCooldowns();
  const now = 1_000_000;
  const loaded: string[] = [];
  const store: KeyCooldownStore = {
    load: async (service) => {
      loaded.push(service);
      return new Map([[hashApiKey('a'), now + (service === 'Indeed12' ? 1_000 : 5_000)]]);
    },
    save: async () => {},
  };
  for (const service of ['Indeed12_Details', 'Indeed12']) {
    await assert.rejects(fetchWithKeyRotation(['a'], async () => { assert.fail('must honor saved cooldown'); }, service, { store, now: () => now + 2_000 }), /cooling down/);
  }
  assert.deepEqual(loaded, ['Indeed12', 'Indeed12_Details']);
  resetKeyCooldowns();
  await assert.rejects(fetchWithKeyRotation(['a'], async () => { assert.fail('restart must retain the later cooldown'); }, 'Indeed12', { store, now: () => now + 2_000 }), /cooling down/);
});

test('a new Indeed description throttle immediately protects search and saves under the shared label', async () => {
  resetKeyCooldowns();
  const saved: string[] = [];
  const store: KeyCooldownStore = { load: async () => new Map(), save: async (service) => { saved.push(service); } };
  await assert.rejects(fetchWithKeyRotation(['a'], async () => new Response('monthly quota', { status: 429 }), 'Indeed12_Details', { store, now: () => 1_000_000 }), /429/);
  await assert.rejects(fetchWithKeyRotation(['a'], async () => { assert.fail('must not retry through search'); }, 'Indeed12', { store, now: () => 1_000_001 }), /cooling down/);
  assert.deepEqual(saved, ['Indeed12']);
});

test('local budget or circuit refusals and cancellation stop rotation immediately', async () => {
  for (const service of ['Indeed12', 'Indeed12_Details', 'Glassdoor']) {
    for (const message of ['Indeed request blocked by paced_budget', 'Glassdoor Details request blocked by daily_budget', 'Indeed Details request blocked by circuit_open']) {
      resetKeyCooldowns();
      let attempts = 0;
      await assert.rejects(fetchWithKeyRotation(['a', 'b', 'c'], async () => { attempts++; throw new Error(message); }, service), { message });
      assert.equal(attempts, 1);
    }
  }
  let attempts = 0;
  await assert.rejects(fetchWithKeyRotation(['a', 'b'], async () => { attempts++; throw new DOMException('Stopped', 'AbortError'); }, 'Indeed12'), /Stopped/);
  assert.equal(attempts, 1);
});

test('transport failures use at most three attempts, expose safe diagnostics, and move on next time', async () => {
  for (const service of ['Indeed12', 'Glassdoor']) {
    resetKeyCooldowns();
    const tried: string[] = [];
    await assert.rejects(fetchWithKeyRotation(['a', 'b', 'c', 'd', 'e'], async (key) => {
      tried.push(key); throw new TypeError('fetch failed: secret request URL', { cause: { code: 'ECONNRESET' } });
    }, service), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /transport failure \(TypeError, ECONNRESET\)/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.deepEqual(tried, ['a', 'b', 'c']);
    await fetchWithKeyRotation(['a', 'b', 'c', 'd', 'e'], async (key) => { assert.equal(key, 'd'); return new Response('{}'); }, service);
  }
});

test('search age buckets cover delayed runs and omit the filter beyond provider age buckets', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  for (const [days, expected] of [[1, '3'], [3.1, '7'], [10, '14'], [20, '30'], [31, null]] as const) {
    const start = new Date(now.getTime() - days * 86_400_000);
    assert.deepEqual(paidSearchAgeParams('Indeed', start, now), expected ? { fromage: expected } : {});
    assert.deepEqual(paidSearchAgeParams('Glassdoor (RapidAPI)', start, now), expected ? { fromAge: expected } : {});
  }
});

test('a pacing refusal retains the transport failure that consumed the available portion', async () => {
  resetKeyCooldowns();
  let diagnostic: PaidSearchDiagnostics = {};
  let attempts = 0;
  await assert.rejects(fetchWithKeyRotation(['a', 'b'], async () => {
    if (++attempts === 1) throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    throw new Error('Indeed request blocked by paced_budget');
  }, 'Indeed12', { onAttempt: (d) => { diagnostic = d; } }), /paced_budget/);
  assert.equal(diagnostic.outcome, 'budget_wait');
  assert.match(String(diagnostic.previousFailure), /ETIMEDOUT/);
});

test('Indeed parsing preserves identity and avoids invalid dates and unusable titles', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const row = { id: 'stable', title: 'Account Manager', company_name: 'Acme', publication_date: 'bad', url: 'https://example.com/job/1' };
  assert.equal(parseIndeedListing(row, now)?.sourceId, 'stable');
  assert.equal(parseIndeedListing(row, now)?.postedAt, now);
  assert.equal(parseIndeedListing({ ...row, title: '' }), null);
  assert.equal(parseIndeedListing({ title: 'Account Manager' }), null);
});

test('empty, malformed and rejected responses have distinct diagnostics for both sources', async () => {
  for (const source of ['Indeed', 'Glassdoor (RapidAPI)'] as const) {
    let diagnostic: PaidSearchDiagnostics = {};
    const parse = source === 'Indeed' ? parseIndeedListing : parseGlassdoorListing;
    const read = (response: Response) => readPaidSearchResponse<unknown>(source, response, parse, (d) => { diagnostic = d; });
    const wrap = (rows: unknown[]) => source === 'Indeed' ? { hits: rows } : { data: { jobListings: rows } };
    await assert.rejects(read(Response.json({ data: {} })), /schema error/);
    assert.equal(diagnostic.outcome, 'schema_error');
    await assert.rejects(read(new Response('bad JSON')), /invalid JSON/);
    assert.equal(diagnostic.outcome, 'invalid_json');
    assert.deepEqual(await read(Response.json(wrap([]))), { jobs: [], rejectedRows: 0 });
    assert.equal(diagnostic.outcome, 'empty_results');
    assert.equal((await read(Response.json(wrap([null, {}])))).rejectedRows, 2);
    assert.equal(diagnostic.outcome, 'invalid_rows');
    await assert.rejects(read(Response.json({ ...wrap([]), status: 'ERROR' })), /schema error/);
    await assert.rejects(read(new Response('provider unavailable', { status: 500 })), /HTTP 500/);
    assert.equal(diagnostic.outcome, 'http_error');
  }
});

test('valid Indeed and Glassdoor rows survive mixed pages while rejected rows are counted', async () => {
  const indeed = { id: '1', title: 'Account Manager', company_name: 'Acme', url: 'https://example.com/1' };
  const glassdoor = { jobview: { header: { employer: { name: 'Acme' }, jobViewUrl: '/job?jobListingId=2' },
    job: { listingId: 2, jobTitleText: 'Account Manager', queryString: 'jobListingId=2' } } };
  let diagnostic: PaidSearchDiagnostics = {};
  const result = await readPaidSearchResponse('Indeed', Response.json({ hits: [indeed, {}] }), parseIndeedListing, (d) => { diagnostic = d; });
  assert.equal(result.jobs[0].sourceId, '1');
  assert.equal(result.rejectedRows, 1);
  assert.equal(diagnostic.returnedRows, 2);
  const gd = await readPaidSearchResponse('Glassdoor (RapidAPI)', Response.json({ data: { jobListings: [glassdoor] } }), parseGlassdoorListing, () => {});
  assert.equal(gd.jobs[0].sourceId, '2');
  assert.equal(gd.jobs[0].glassdoorQueryString, 'jobListingId=2');
});
