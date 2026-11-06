import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchEmployerBoardPostings } from '../employerBoardPostings';
import { resolveDirectAtsPostingFromCatalogue, type BoardPosting } from '../atsDirectMatch';
import type { safeExternalFetch } from '../safeExternalFetch';

const lever = (n: number) => ({ text: 'Account Executive', hostedUrl: `https://jobs.lever.co/acme/${n}`,
  categories: { location: 'USA' }, descriptionPlain: 'Employer posting' });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('Lever completes every page before a match can be selected', async () => {
  const skips: number[] = [];
  const fetcher = (async (value: string | URL) => {
    const skip = Number(new URL(String(value)).searchParams.get('skip'));
    skips.push(skip);
    return json(skip === 0 ? Array.from({ length: 100 }, (_, i) => lever(i)) : [lever(100)]);
  }) as typeof safeExternalFetch;
  assert.equal((await fetchEmployerBoardPostings({ platform: 'lever', slug: 'acme' }, fetcher))?.length, 101);
  assert.deepEqual(skips, [0, 100]);
});

test('a failed second page or repeated catalogue refuses all partial results', async () => {
  for (const repeated of [false, true]) {
    const fetcher = (async (value: string | URL) => {
      const skip = Number(new URL(String(value)).searchParams.get('skip'));
      if (skip && !repeated) return new Response('', { status: 429 });
      return json(Array.from({ length: 100 }, (_, i) => lever(i)));
    }) as typeof safeExternalFetch;
    assert.equal(await fetchEmployerBoardPostings({ platform: 'lever', slug: 'acme' }, fetcher), null);
  }
});

test('malformed, truncated, foreign-board, and unsupported catalogues fail closed', async () => {
  for (const body of [{ jobs: [] , meta: { total: 2 } }, { jobs: [{ title: 'AE', absolute_url: 'https://job-boards.greenhouse.io/other/jobs/1' }] },
    { jobs: [{ title: '', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1' }] }, { error: 'blocked' }]) {
    const fetcher = (async () => json(body)) as typeof safeExternalFetch;
    assert.equal(await fetchEmployerBoardPostings({ platform: 'greenhouse', slug: 'acme' }, fetcher), null);
  }
  const fetcher = (async () => { throw new Error('Must not request unsupported feeds'); }) as typeof safeExternalFetch;
  assert.equal(await fetchEmployerBoardPostings({ platform: 'workday', slug: 'acme.wd1::acme' }, fetcher), null);
});

test('SmartRecruiters finishes every page before exposing a candidate catalogue', async () => {
  const offsets: number[] = [];
  const content = Array.from({ length: 101 }, (_, i) => ({ id: String(100000 + i), name: 'Account Manager',
    company: { identifier: 'acme' }, location: { city: 'Minneapolis', region: 'MN' } }));
  const result = await fetchEmployerBoardPostings({ platform: 'smartrecruiters', slug: 'acme' }, async input => {
    const offset = Number(new URL(input).searchParams.get('offset'));
    offsets.push(offset);
    return Response.json({ totalFound: content.length, content: content.slice(offset, offset + 100) });
  });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(result?.length, 101);
  assert.equal(await fetchEmployerBoardPostings({ platform: 'smartrecruiters', slug: 'acme' },
    async () => Response.json({ totalFound: 101, content: content.slice(0, 1) })), null);
});

test('Workable follows its published continuation token and preserves JSON request headers', async () => {
  const requests: Record<string, unknown>[] = [];
  const result = await fetchEmployerBoardPostings({ platform: 'workable', slug: 'acme' }, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ total: 2, results: [{ title: 'Account Manager', shortcode: `JOB${requests.length}`,
      location: { city: 'Minneapolis', country: 'United States' } }],
      ...(requests.length === 1 ? { nextPage: 'page-two' } : {}) });
  });
  assert.equal(result?.length, 2);
  assert.equal(requests[1].token, 'page-two');
  assert.equal(await fetchEmployerBoardPostings({ platform: 'workable', slug: 'acme' }, async () =>
    Response.json({ total: 2, results: [{ title: 'Account Manager', shortcode: 'JOB1' }] })), null);
});

test('single-board lookups reject partial, malformed and foreign catalogues', async () => {
  const row = { title: 'Account Manager', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123456' };
  for (const body of [{ jobs: [row], meta: { total: 2 } }, { jobs: [row, {}] },
    { jobs: [{ ...row, absolute_url: row.absolute_url.replace('/acme/', '/different/') }] }]) {
    assert.equal(await fetchEmployerBoardPostings({ platform: 'greenhouse', slug: 'acme' },
      async () => Response.json(body)), null);
  }
  assert.equal(await fetchEmployerBoardPostings({ platform: 'greenhouse', slug: 'acme' }, async () => {
    const response = Response.json({ jobs: [row] });
    Object.defineProperty(response, 'url', { value: 'https://foreign.example/jobs' });
    return response;
  }), null);
});

test('shared recovery distinguishes a cached unavailable board from a complete empty board', async () => {
  const board = { platform: 'greenhouse', slug: 'acme' };
  const catalogue = { board, boards: [board], postings: [] };
  const job = { title: 'Account Manager', company: 'Acme', location: 'USA', source: 'JSearch' };
  const store = { job: {} } as never;
  const outcomes: string[] = [];
  const liveCache = new Map<string, Promise<BoardPosting[] | null>>();
  let requests = 0;
  const deps = { store, liveCache, onOutcome: (value: string) => outcomes.push(value),
    fetcher: async () => { requests += 1; return new Response('', { status: 503 }); } };
  await resolveDirectAtsPostingFromCatalogue(job, catalogue, deps);
  await resolveDirectAtsPostingFromCatalogue(job, catalogue, deps);
  assert.equal(requests, 1);
  assert.deepEqual(outcomes, ['live_unavailable', 'live_unavailable']);
  await resolveDirectAtsPostingFromCatalogue(job, catalogue, { ...deps, liveCache: new Map(),
    fetcher: async () => Response.json({ jobs: [] }) });
  assert.equal(outcomes.at(-1), 'no_unique_live_match');
});
