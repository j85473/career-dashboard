import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { assessAggregatorIntake } from '../aggregatorIntake';
import { aggregatorIntakeRetryAt, retainAggregatorCandidate, retryAggregatorCandidates } from '../aggregatorIntakeQueue';
import { Prisma } from '../prismaClient';

const job = { title: 'Channel Sales Manager', company: 'Huntress', location: 'USA', source: 'Himalayas', url: 'https://himalayas.app/companies/huntress/jobs/channel-sales-manager' };
const posting = { title: job.title, absolute_url: 'https://job-boards.greenhouse.io/huntress/jobs/123456', location: { name: 'USA' }, content: 'Employer job description' };
function store(rows: unknown[] = [], known = true, excluded = false) {
  return { job: { findMany: async () => rows },
    companyNameRule: { findMany: async () => known ? [{ matchType: 'ats_board_employer', matchKey: 'greenhouse:huntress', standardName: 'Huntress', origin: 'verified_ats_source' }] : [] },
    atsCompany: { findMany: async () => [{ platform: 'greenhouse', slug: 'huntress', status: excluded ? 'excluded' : 'active', excludedReason: excluded ? 'permanent_retirement:test' : null }] },
  } as never;
}
const response = (jobs: unknown[], total = jobs.length) => Response.json({ jobs, meta: { total } });

test('the scheduled retry entrypoint launches under the production CommonJS runner', () => {
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/retry_aggregator_intake.ts', '--invalid'],
    { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' } });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage: retry_aggregator_intake\.ts/);
  assert.doesNotMatch(child.stderr, /Transform failed|Top-level await/);
});

test('a saved employer match admits the source without calling its board', async () => {
  const result = await assessAggregatorIntake(job, { store: store([{ id: 'one', title: job.title, company: job.company, source: 'ATS-greenhouse', url: posting.absolute_url, canonicalUrl: posting.absolute_url, location: 'USA', description: 'Employer job description', observations: [] }]),
    fetcher: async () => { throw new Error('Stored match must not fetch'); } });
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.match.matchedVia, 'stored');
});

test('a missing saved job queries the known board and admits its exact live match', async () => {
  let requests = 0;
  const result = await assessAggregatorIntake(job, { store: store(), fetcher: async () => { requests++; return response([posting]); } });
  assert.equal(requests, 1); assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.match.url, posting.absolute_url);
});

test('a complete successful board with no matching posting rejects the stale arrival', async () => {
  for (const jobs of [[], [{ ...posting, title: 'Security Analyst' }]]) {
    const result = await assessAggregatorIntake(job, { store: store(), fetcher: async () => response(jobs) });
    assert.deepEqual(result, { kind: 'expired', reason: 'absent_from_complete_employer_catalogue', boards: [{ platform: 'greenhouse', slug: 'huntress' }] });
  }
});

test('timeouts, blocks, malformed and incomplete boards wait; they never establish expiry', async () => {
  for (const fetcher of [async () => { throw new Error('timeout'); }, async () => new Response('', { status: 403 }),
    async () => Response.json({ error: 'unavailable' }), async () => response([posting], 2)]) {
    assert.deepEqual(await assessAggregatorIntake(job, { store: store(), fetcher }), { kind: 'pending', reason: 'live_unavailable' });
  }
});

test('several live requisitions stay pending rather than choosing one or declaring expiry', async () => {
  const result = await assessAggregatorIntake(job, { store: store(), fetcher: async () => response([posting, { ...posting, absolute_url: posting.absolute_url.replace('123456', '234567') }]) });
  assert.deepEqual(result, { kind: 'pending', reason: 'no_unique_live_match' });
});

test('retired boards are checked on demand while genuinely unknown employers remain distinct', async () => {
  const fetcher = async () => { throw new Error('No active board to request'); };
  assert.deepEqual(await assessAggregatorIntake(job, { store: store([], false), fetcher }), { kind: 'unknown_board' });
  let calls = 0;
  const result = await assessAggregatorIntake(job, { store: store([], true, true), fetcher: async () => { calls++; return response([posting]); } });
  assert.equal(calls, 1); assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.match.matchedVia, 'live');
  assert.equal((await assessAggregatorIntake(job, { store: store([], true, true), fetcher: async () => response([]) })).kind, 'expired');
  assert.deepEqual(await assessAggregatorIntake(job, { store: store([], true, true), fetcher }), { kind: 'pending', reason: 'live_unavailable' });
});

test('an unavailable second employer board prevents a false expiry', async () => {
  const fake = { job: { findMany: async () => [] },
    companyNameRule: { findMany: async () => ['current', 'legacy'].map(slug => ({
      matchType: 'ats_board_employer', matchKey: `greenhouse:${slug}`, standardName: 'Huntress', origin: 'verified_ats_source',
    })) },
    atsCompany: { findMany: async () => [
      { platform: 'greenhouse', slug: 'current', status: 'active' },
      { platform: 'greenhouse', slug: 'legacy', status: 'excluded', excludedReason: 'permanent_retirement:test' },
    ] },
  } as never;
  const fetcher = async (url: string | URL) => String(url).includes('/legacy/') ? new Response('', { status: 503 }) : response([]);
  assert.equal((await assessAggregatorIntake(job, { store: fake, fetcher })).kind, 'pending');
});

test('retired saved postings cannot bypass the targeted live check or reactivate collection', async () => {
  const saved = { id: 'one', title: job.title, company: job.company, source: 'ATS-greenhouse',
    url: posting.absolute_url, canonicalUrl: posting.absolute_url, location: 'USA', description: 'Employer job description', observations: [] };
  const result = await assessAggregatorIntake(job, { store: store([saved], true, true), fetcher: async () => response([]) });
  assert.equal(result.kind, 'expired');
  // The fake store exposes reads only: an attempted registry write would fail.
});

test('pending intake is durable without a Job write; absence discards the retained JD', async () => {
  const writes: any[] = [];
  const fake = { aggregatorIntakeCandidate: { upsert: async (value: unknown) => { writes.push(value); } } } as never;
  const input = { job: { ...job, sourceId: '123', description: 'Full original JD' }, ...job, sourceId: '123', reason: 'live_unavailable', expired: false, context: {} };
  await retainAggregatorCandidate(input, fake, new Date('2026-11-06T00:00:00Z'));
  assert.equal(writes[0].create.status, 'pending'); assert.equal(writes[0].create.payload.description, 'Full original JD');
  assert.equal('nextAttemptAt' in writes[0].update, false); assert.equal('leaseToken' in writes[0].update, false);
  await retainAggregatorCandidate({ ...input, expired: true, reason: 'absent_from_complete_employer_catalogue' }, fake);
  assert.equal(writes[1].update.status, 'expired'); assert.equal(writes[1].update.payload, Prisma.DbNull);
});

test('retry leases prevent double admission and retain failures for a later attempt', async () => {
  for (const claim of [0, 1]) {
    let calls = 0; const updates: any[] = [];
    const fake = { pipelineState: { findUnique: async () => null }, aggregatorIntakeCandidate: {
      findMany: async () => [{ id: 'candidate', source: 'Himalayas', sourceId: '123', payload: job, attempts: 1 }],
      updateMany: async (args: any) => { updates.push(args); return { count: claim }; },
      findUnique: async () => ({ status: 'pending' }),
    }, jobSourceObservation: { findUnique: async () => null } } as never;
    const result = await retryAggregatorCandidates({ limit: 10, ingest: async () => { calls++; throw new Error('temporary failure'); } }, fake);
    assert.equal(calls, claim); assert.equal(result.pending, claim);
    if (claim) { assert.equal(updates.at(-1).data.status, 'pending'); assert.match(updates.at(-1).data.lastError, /temporary failure/); assert.equal('payload' in updates.at(-1).data, false); }
  }
});

test('a successful retry retires its payload only after a real source observation exists', async () => {
  const updates: any[] = [];
  const fake = { pipelineState: { findUnique: async () => null }, aggregatorIntakeCandidate: {
    findMany: async () => [{ id: 'candidate', source: 'Himalayas', sourceId: '123', payload: job, attempts: 0 }],
    updateMany: async (args: any) => { updates.push(args); return { count: 1 }; }, findUnique: async () => ({ status: 'pending' }),
  }, jobSourceObservation: { findUnique: async () => ({ jobId: 'real-job' }) } } as never;
  assert.equal((await retryAggregatorCandidates({ limit: 1, ingest: async () => {} }, fake)).released, 1);
  assert.equal(updates.at(-1).data.jobId, 'real-job'); assert.equal(updates.at(-1).data.payload, Prisma.DbNull);
  const now = new Date('2026-11-06T00:00:00Z');
  assert.equal(aggregatorIntakeRetryAt(1, now).getTime() - now.getTime(), 600_000);
  assert.equal(aggregatorIntakeRetryAt(100, now).getTime() - now.getTime(), 21_600_000);
});

test('scheduled retries honor indefinite and timed pauses, including a pause between candidates', async () => {
  for (const mode of ['indefinite', 'timed', 'expired', 'between']) {
    let checks = 0, claims = 0;
    const fake = {
      pipelineState: { findUnique: async () => {
        checks++;
        return { schedulePaused: true, pausedUntil: mode === 'indefinite' || mode === 'between' && checks > 1
          ? null : new Date(Date.now() + (mode === 'timed' ? 60_000 : -60_000)) };
      } },
      aggregatorIntakeCandidate: {
        findMany: async () => [1, 2].map(id => ({ id: String(id), source: 'Himalayas', sourceId: String(id), payload: job, attempts: 0 })),
        updateMany: async (args: any) => { if (args.data.attempts) claims++; return { count: 1 }; },
        findUnique: async () => ({ status: 'pending' }),
      }, jobSourceObservation: { findUnique: async () => null },
    } as never;
    const result = await retryAggregatorCandidates({ limit: 2, ingest: async () => {} }, fake);
    const expected = mode === 'expired' ? 2 : mode === 'between' ? 1 : 0;
    assert.equal(claims, expected, mode); assert.equal(result.attempted, expected, mode);
  }
});
