import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverEmployerBoards, employerPageLinks } from '../employerAtsDiscovery';
import type { safeExternalFetch } from '../safeExternalFetch';

function response(body: string, url: string, contentType: string): Response {
  const value = new Response(body, { status: 200, headers: { 'content-type': contentType } });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}

test('employer pages expose same-site career paths and supported public boards', () => {
  const links = employerPageLinks(`
    <a href="/about/careers">Join our team</a>
    <a href="https://careers.panopto.com/jobs">Open positions</a>
    <a href="https://jobs.lever.co/panopto">Career opportunities</a>
    <iframe src="https://job-boards.greenhouse.io/panopto"></iframe>
  `, 'https://panopto.com/');
  assert.deepEqual(links.careerPages, [
    'https://panopto.com/about/careers',
    'https://careers.panopto.com/jobs',
  ]);
  assert.deepEqual(links.boards.map(({ board }) => board), [
    { platform: 'lever', slug: 'panopto' },
    { platform: 'greenhouse', slug: 'panopto' },
  ]);
});

test('official-site discovery verifies a board with a unique live posting match', async () => {
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url === 'https://example.com/') {
      return response('<a href="https://jobs.lever.co/acme">Careers</a>', url, 'text/html');
    }
    if (url.startsWith('https://api.lever.co/v0/postings/acme')) {
      return response(JSON.stringify([{
        text: 'Senior Account Executive',
        hostedUrl: 'https://jobs.lever.co/acme/req-1234',
        categories: { location: 'Remote, United States' },
        descriptionPlain: 'Employer posting body',
      }]), url, 'application/json');
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof safeExternalFetch;

  const found = await discoverEmployerBoards({
    website: 'https://example.com/',
    jobs: [{ title: 'Senior Account Executive', location: 'USA' }],
    fetcher,
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].board, { platform: 'lever', slug: 'acme' });
  assert.equal(found[0].matchCount, 1);
  assert.equal(found[0].evidenceUrl, 'https://example.com/');
});

test('a linked board with no matching requisition is not persisted as the employer board', async () => {
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url === 'https://example.com/') {
      return response('<a href="https://jobs.lever.co/acme">Careers</a>', url, 'text/html');
    }
    if (url.startsWith('https://api.lever.co/v0/postings/acme')) {
      return response(JSON.stringify([{
        text: 'Software Engineer',
        hostedUrl: 'https://jobs.lever.co/acme/req-9876',
        categories: { location: 'Toronto, Canada' },
      }]), url, 'application/json');
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof safeExternalFetch;
  assert.deepEqual(await discoverEmployerBoards({
    website: 'https://example.com/',
    jobs: [{ title: 'Senior Account Executive', location: 'USA' }],
    fetcher,
  }), []);
});

const executive = { text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/acme/ae', categories: { location: 'USA' } };

test('an unrelated redirect and marketing links cannot supply employer evidence', async () => {
  const links = employerPageLinks('<a href="https://jobs.lever.co/customer">Customer story</a>', 'https://example.com/');
  assert.deepEqual(links.boards, []);
  const fetcher = (async () => response('<a href="https://jobs.lever.co/acme">Careers</a>', 'https://unrelated.example/', 'text/html')) as typeof safeExternalFetch;
  assert.deepEqual(await discoverEmployerBoards({ website: 'https://example.com/', jobs: [{ title: 'Account Executive', location: 'USA' }], fetcher }), []);
});

test('all linked catalogues participate in ambiguity checks, including boards without a unique hit', async () => {
  const fetcher = (async (value: string | URL) => {
    const url = String(value);
    if (url === 'https://example.com/') return response('<a href="https://jobs.lever.co/acme">Careers</a><a href="https://job-boards.greenhouse.io/acme">Jobs</a>', url, 'text/html');
    if (new URL(url).hostname === 'api.lever.co') return response(JSON.stringify([executive,
      { ...executive, text: 'Software Engineer', hostedUrl: 'https://jobs.lever.co/acme/eng' }]), url, 'application/json');
    if (new URL(url).hostname === 'boards-api.greenhouse.io') return response(JSON.stringify({ jobs: [{ title: 'Account Executive', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123', location: { name: 'USA' } }] }), url, 'application/json');
    return new Response('', { status: 404 });
  }) as typeof safeExternalFetch;
  assert.deepEqual(await discoverEmployerBoards({ website: 'https://example.com/', jobs: [{ title: 'Account Executive', location: 'USA' }], fetcher }), []);
  const catalogues = await discoverEmployerBoards({ website: 'https://example.com/', jobs: [{ title: 'Software Engineer', location: 'USA' }, { title: 'Account Executive', location: 'USA' }], fetcher });
  assert.equal(catalogues.length, 2);
  assert.deepEqual(catalogues.map(item => item.matchCount), [1, 0]);
});

test('an unreadable linked board defers an employer even when another board matches', async () => {
  const fetcher = (async (value: string | URL) => {
    const url = String(value);
    if (url === 'https://example.com/') return response('<a href="https://jobs.lever.co/acme">Careers</a><a href="https://job-boards.greenhouse.io/acme">Jobs</a>', url, 'text/html');
    if (new URL(url).hostname === 'api.lever.co') return response(JSON.stringify([executive]), url, 'application/json');
    return new Response('', { status: 503 });
  }) as typeof safeExternalFetch;
  assert.deepEqual(await discoverEmployerBoards({ website: 'https://example.com/', jobs: [{ title: 'Account Executive', location: 'USA' }], fetcher }), []);
});

test('an employer timeout ends the crawl without returning partial proof', async () => {
  const fetcher = ((_value: string | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error('Test request exceeded its bound')), 200);
    init.signal?.addEventListener('abort', () => { clearTimeout(fallback); reject(new Error('Aborted')); }, { once: true });
  })) as typeof safeExternalFetch;
  assert.deepEqual(await discoverEmployerBoards({ website: 'https://example.com/',
    jobs: [{ title: 'Account Executive', location: 'USA' }], fetcher, totalTimeoutMs: 10 }), []);
});
