import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchEmployerBoardPostings } from '../employerBoardPostings';
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
