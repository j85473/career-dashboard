import assert from 'node:assert/strict';
import test from 'node:test';
import { jsearchDateFilter, newJSearchProgress, parseJSearchResponse, readJSearchProgress, runJSearchPages, type JSearchDiagnostics, type JSearchProgress } from '../jsearch';
import { parseJSearchJob } from '../jobIngestion';
import { evaluateProviderAvailability, evaluateProviderBudget, providerTaskAvailability } from '../ingestionControl';
import { fetchWithKeyRotation, resetKeyCooldowns } from '../apiFallback';

const now = new Date('2026-09-06T12:00:00Z');
const start = new Date('2026-09-05T10:00:00Z');
const initial = () => newJSearchProgress('channel account manager in Minnesota', start, now, now);
const row = (id: string) => ({ job_uid: id, job_title: 'Channel Account Manager', employer_name: 'Acme', job_apply_link: `https://example.com/jobs/${id}` });
const response = (ids: string[], cursor: string | null) => Response.json({ status: 'OK', data: { jobs: ids.map(row), cursor } });

test('catch-up selects a covering date range, with an indexing cushion for daily searches', () => {
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  assert.equal(jsearchDateFilter(days(1), now), '3days');
  assert.equal(jsearchDateFilter(days(3), now), '3days');
  assert.equal(jsearchDateFilter(days(3.01), now), 'week');
  assert.equal(jsearchDateFilter(days(7), now), 'week');
  assert.equal(jsearchDateFilter(days(7.01), now), 'month');
  assert.equal(jsearchDateFilter(days(31), now), 'all');
  assert.equal(readJSearchProgress({ phase: 'finished' }), null);
  assert.equal(readJSearchProgress({ jsearch: { ...initial(), windowStart: 'bad' } }), null);
});

test('follows provider cursors, not page numbers, including empty pages with a continuation', async () => {
  const requests: URLSearchParams[] = [];
  const jobs: string[] = [];
  const saved: JSearchProgress[] = [];
  const pages = [response(['one'], 'next'), response([], 'last'), response(['two'], null)];
  const result = await runJSearchPages({ progress: initial(), fetchPage: async (params) => {
    requests.push(params);return pages.shift()!;
  }, parseJob: parseJSearchJob, processJob: async (job) => { jobs.push(String(job.sourceId)); },
  checkpoint: async (p) => { saved.push(p); }, diagnose: () => {} });
  assert.deepEqual(requests.map((p) => p.get('cursor')), [null, 'next', 'last']);
  assert.ok(requests.every((p) => !p.has('page') && !p.has('num_pages') && p.get('date_posted') === '3days'));
  assert.deepEqual(jobs, ['one', 'two']);
  assert.equal(result.complete, true);
  assert.equal(saved.length, 3);
});

test('budget interruption resumes the next page and preserves the assigned search window', async () => {
  let durable = initial();
  let calls = 0;
  const seen: string[] = [];
  const run = (progress: JSearchProgress, fetchPage: (p: URLSearchParams) => Promise<Response>) => runJSearchPages({
    progress, fetchPage, parseJob: parseJSearchJob, processJob: async (job) => { seen.push(String(job.sourceId)); },
    checkpoint: async (p) => { durable = p; }, diagnose: () => {},
  });
  await assert.rejects(run(durable, async () => {
    if (++calls === 2) throw new Error('JSearch request blocked by paced_budget');
    return response(['one'], 'resume-here');
  }), /paced_budget/);
  const restored = readJSearchProgress(JSON.parse(JSON.stringify({ jsearch: durable })))!;
  assert.equal(restored.cursor, 'resume-here');
  assert.equal(restored.complete, false);
  const result = await run(restored, async (params) => {
    assert.equal(params.get('cursor'), 'resume-here');return response(['two'], null);
  });
  assert.equal(result.windowStart, start.toISOString());
  assert.equal(result.windowEnd, now.toISOString());
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(result.complete, true);
});

test('turn limit retains continuation rather than claiming a finished search', async () => {
  const result = await runJSearchPages({ progress: initial(), maxPages: 1,
    fetchPage: async () => response(['one'], 'later'), parseJob: parseJSearchJob,
    processJob: async () => {}, checkpoint: async () => {}, diagnose: () => {} });
  assert.equal(result.complete, false);
  assert.equal(result.cursor, 'later');
});

test('schema drift, invalid JSON, rejected rows and genuine empty results remain distinct', async () => {
  assert.throws(() => parseJSearchResponse({ status: 'OK', data: [] }, 200), /schema mismatch/);
  assert.throws(() => parseJSearchResponse({ status: 'ERROR', data: { jobs: [] } }, 200), /schema mismatch/);
  assert.throws(() => parseJSearchResponse({ status: 'OK', data: { jobs: [], cursor: {} } }, 200), /schema mismatch/);
  for (const [reply, outcome, errorPattern] of [
    [new Response('not-json'), 'invalid_json', /not valid JSON/],
    [Response.json({ status: 'OK', data: { jobs: [{ job_title: 'Missing ID' }, row('valid')], cursor: null } }), 'invalid_rows', /rejected 1 of 2/],
    [response([], null), 'empty_results', null],
  ] as const) {
    let diagnostic: JSearchDiagnostics = {};
    let checkpoints = 0;
    const accepted: string[] = [];
    const work = runJSearchPages({ progress: initial(), fetchPage: async () => reply, parseJob: parseJSearchJob,
      processJob: async (job) => { accepted.push(String(job.sourceId)); }, checkpoint: async () => { checkpoints++; },
      diagnose: (d) => { diagnostic = d; } });
    if (errorPattern) await assert.rejects(work, errorPattern);else assert.equal((await work).complete, true);
    assert.equal(diagnostic.outcome, outcome);
    assert.equal(checkpoints, errorPattern ? 0 : 1);
    if (outcome === 'invalid_rows') assert.deepEqual(accepted, ['valid']);
    assert.doesNotMatch(JSON.stringify(diagnostic), /Missing ID|example.com|job_description/);
  }
});

test('interrupted processing and repeated cursors cannot skip uncompleted work', async () => {
  let saved: JSearchProgress | null = null;
  const abort = new AbortController();
  await assert.rejects(runJSearchPages({ progress: initial(), signal: abort.signal,
    fetchPage: async () => response(['one'], 'next'), parseJob: parseJSearchJob,
    processJob: async () => { abort.abort(); }, checkpoint: async (p) => { saved = p; }, diagnose: () => {} }), /abort/i);
  assert.equal(saved, null);
  await assert.rejects(runJSearchPages({ progress: initial(),
    fetchPage: async () => response(['one'], 'next'), parseJob: parseJSearchJob,
    processJob: async () => { throw new Error('storage unavailable'); },
    checkpoint: async () => { assert.fail('failed processing must retain the page'); }, diagnose: () => {} }), /storage unavailable/);
  await assert.rejects(runJSearchPages({ progress: { ...initial(), cursor: 'same' },
    fetchPage: async () => response(['one'], 'same'), parseJob: parseJSearchJob,
    processJob: async () => {}, checkpoint: async () => { assert.fail('must not advance'); }, diagnose: () => {} }), /repeated pagination cursor/);
});

test('JSearch releases its unchanged 103 daily requests over 24 hours and honors monthly/circuit constraints', () => {
  let dailyUsed = 0;
  const portions: number[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const at = new Date(`2026-09-06T${String(hour).padStart(2, '0')}:00:00Z`);
    const before = dailyUsed;
    while (evaluateProviderBudget({ provider: 'JSearch', state: 'closed', dailyLimit: 103, monthlyLimit: 3200, dailyUsed, monthlyUsed: 600 + dailyUsed, now: at }).allowed) dailyUsed++;
    portions.push(dailyUsed - before);
    const refusal = evaluateProviderBudget({ provider: 'JSearch', state: 'closed', dailyLimit: 103, dailyUsed, monthlyUsed: dailyUsed, now: at });
    assert.equal(refusal.reason, hour === 23 ? 'daily_budget' : 'paced_budget');
    assert.ok(refusal.retryAt!.getTime() > at.getTime());
  }
  assert.equal(dailyUsed, 103);
  assert.ok(portions.every((n) => n === 4 || n === 5));
  const input = { provider: 'JSearch', state: 'closed', dailyLimit: 103, monthlyLimit: 3200, dailyUsed: 103, monthlyUsed: 3200, now };
  assert.equal(evaluateProviderBudget(input).reason, 'monthly_budget');
  const old = { ...input, budgetDay: '2026-09-05', budgetMonth: '2026-08' };
  assert.equal(evaluateProviderAvailability(old).allowed, true);
  assert.equal(evaluateProviderBudget({ ...input, provider: 'SerpApi', dailyUsed: 4, monthlyUsed: 10 }).allowed, true);
  const midnight = new Date('2026-09-06T00:20:00Z');
  const record = { state: 'closed', dailyLimit: 103, monthlyLimit: 3200, dailyUsed: 4, monthlyUsed: 600, budgetDay: '2026-09-06', budgetMonth: '2026-09' };
  assert.equal(providerTaskAvailability('JSearch', record, record, midnight)?.reason, 'paced_budget');
  assert.equal(providerTaskAvailability('JSearch', { ...record, state: 'open', openUntil: new Date('2026-09-07T12:00:00Z') }, record, midnight)?.reason, 'circuit_open');
});

test('a shared pacing refusal does not rotate across every API credential', async () => {
  resetKeyCooldowns();
  let attempts = 0;
  await assert.rejects(fetchWithKeyRotation(['one', 'two', 'three'], async () => {
    attempts++;throw new Error('JSearch request blocked by paced_budget');
  }, 'JSearch'), /paced_budget/);
  assert.equal(attempts, 1);
});
