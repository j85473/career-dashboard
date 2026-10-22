import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
const require = createRequire(import.meta.url);
const dns = require('node:dns/promises');
function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const prior = Reflect.get(target, key);
  assert.equal(Reflect.set(target, key, implementation), true);
  t.after(() => { Reflect.set(target, key, prior); });
}
const id = '18e12d92-d9ec-4388-a6cf-3c62d1369681';

test('a new Censys application-frame import saves authored API metadata and no application form', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  const text = 'Responsibilities: Activate existing channel partners, lead account planning and deliver enablement. Qualifications: Five years of channel management experience. '.repeat(8);
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { servername: string; path: string }, callback: (body: Readable) => void) => {
    assert.equal(options.servername, 'boards-api.greenhouse.io');
    assert.equal(options.path, '/v1/boards/censys/jobs/8756673002');
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      const incoming = Object.assign(Readable.from([Buffer.from(JSON.stringify({ id: 8756673002,
        title: 'Channel Account Manager, Central', company_name: 'Censys',
        location: { name: 'Remote - Central United States (Chicago, Dallas)' }, content: `<p>${text}</p>` }))]),
      { statusCode: 200, statusMessage: 'OK', headers: {}, rawHeaders: ['Content-Type', 'application/json'] });
      queueMicrotask(() => callback(incoming));
    } });
  });
  let created: Record<string, unknown> | null = null;
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findFirst', async () => null);
  replace(t, prisma.job, 'create', async ({ data }: { data: Record<string, unknown> }) => {
    created = { id: 'new-censys', ...data }; return created;
  });
  replace(t, prisma.job, 'findUnique', async () => created);
  replace(t, prisma.job, 'updateMany', async () => ({ count: 0 }));
  replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  replace(t, prisma, '$executeRaw', async () => 0);
  replace(t, prisma.companyNameRule, 'findMany', async () => []);
  replace(t, prisma.atsCompany, 'findMany', async () => [{ slug: 'censys', platform: 'greenhouse', status: 'active' }]);
  replace(t, prisma.atsCompany, 'update', async () => ({}));
  const response = await POST(new Request('http://localhost/api/jobs/manual-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002' }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.title, 'Channel Account Manager, Central');
  assert.equal(result.job.company, 'Censys');
  assert.equal(result.job.location, 'Remote - Central United States (Chicago, Dallas)');
  assert.equal(result.job.url, 'https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002');
  assert.equal(result.job.userCanonicalUrl, result.job.url);
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.scoringStatus, 'queued');
  assert.equal(result.job.description, text.trim());
  assert.equal(result.refreshWarning, undefined);
});

test('unavailable OG ATS postings reject new imports before any writes or page-reader fallback', async t => {
  const { POST: importJob } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  let validApiDescription = false;
  const description = 'Responsibilities: Enable existing partners and manage account plans. Qualifications: Five years of channel sales experience. '.repeat(8);
  t.mock.method(require('node:https'), 'request', (options: { servername: string }, callback: (body: Readable) => void) => {
    // The refresh route also probes the hosted posting; keep that probe offline.
    if (!['api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com'].includes(options.servername)) {
      const error = new Error('Offline redirect probe'); error.name = 'AbortError'; throw error;
    }
    const body = options.servername === 'api.lever.co' || options.servername === 'api.eu.lever.co'
      ? { id, text: 'Account Manager', descriptionPlain: description, categories: { location: 'Chicago, IL' } }
      : { jobs: [{ id, title: 'Account Manager', descriptionPlain: description, location: 'Chicago, IL' }] };
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      const incoming = Object.assign(Readable.from([Buffer.from(validApiDescription ? JSON.stringify(body) : '')]),
        { statusCode: validApiDescription ? 200 : 404, headers: {}, rawHeaders: ['Content-Type', 'application/json'] });
      queueMicrotask(() => callback(incoming));
    } });
  });
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findUnique', async () => ({ id: 'saved-card', observations: [] }));
  for (const method of ['create', 'update', 'updateMany', 'delete'] as const) {
    replace(t, prisma.job, method, async () => assert.fail('Unverified postings must not change cards or scores'));
  }
  replace(t, prisma, '$transaction', async () => assert.fail('Unverified postings must not start a write transaction'));
  const request = (url: string) => new Request('http://localhost/api/jobs/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, skipRescore: true }),
  });
  for (const url of ['https://job-boards.greenhouse.io/embed/job_app?for=censys',
    `https://jobs.eu.lever.co/acme/${id}/apply`, `https://jobs.ashbyhq.com/acme/${id}/application`]) {
    const imported = await importJob(request(url));
    assert.equal(imported.status, 422, JSON.stringify(await imported.clone().json()));
    assert.match((await imported.json()).error, /No job was imported/);
  }
  // A valid API description cannot make an unresolved employer a valid card.
  validApiDescription = true;
  for (const url of [`https://jobs.lever.co/acme/${id}`, `https://jobs.ashbyhq.com/acme/${id}`]) {
    const response = await importJob(request(url));
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
    assert.match((await response.json()).error, /verified job title and employer/);
  }
});

test('a Greenhouse application alias reopens a saved posting with scores and lifecycle intact', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  const url = 'https://job-boards.greenhouse.io/censys/jobs/8756673002';
  let existing = { id: 'saved-censys', title: 'Channel Account Manager, Central', company: 'Censys',
    url, canonicalUrl: url, source: 'Manual Import', status: 'applied', scoringStatus: 'scored',
    fitScore: 55, aimFitScore: 87, reqFitScore: 89, tailoringStaged: false, passReason: null,
    jdBatchId: 'active-work', updatedAt: new Date('2026-10-20T19:09:13.193Z') };
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  replace(t, prisma.job, 'findMany', async (query: { where: { OR: Record<string, unknown>[] } }) => {
    assert.ok(query.where.OR.some(condition => condition.url === url));
    assert.ok(query.where.OR.some(condition => condition.canonicalUrl === url));
    return [existing];
  });
  replace(t, prisma.job, 'findUnique', async () => existing);
  replace(t, prisma.jobStatusHistory, 'findFirst', async () => null);
  replace(t, prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    assert.deepEqual(Object.keys(data).sort(), ['canonicalUrl', 'url', 'userCanonicalUrl', 'userCanonicalUrlUpdatedAt']);
    existing = { ...existing, ...data }; return { count: 1 };
  });
  for (const method of ['create', 'update', 'delete'] as const) {
    replace(t, prisma.job, method, async () => assert.fail('Reopening a saved card must preserve existing work'));
  }
  replace(t, prisma, '$transaction', async () => assert.fail('No score or lifecycle transaction permitted'));
  const response = await POST(new Request('http://localhost/api/jobs/manual-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002' }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.isDuplicate, true);
  assert.equal(result.job.id, existing.id);
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.fitScore, 55);
  assert.equal(result.job.aimFitScore, 87);
  assert.equal(result.job.reqFitScore, 89);
  assert.equal(result.job.tailoringStaged, false);
  assert.equal(result.job.url, 'https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002');
});

test('an unavailable posting still saves the exact user link while retaining details, scores and lifecycle', async t => {
  const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
  const { prisma } = await import('../../src/lib/prisma');
  const old = { id: 'saved-card', title: 'Account Manager', company: 'Acme', description: 'Existing scored description',
    url: 'https://old.example/jobs/12345', canonicalUrl: 'https://old.example/jobs/12345',
    status: 'applied', tailoringStaged: false, source: 'Manual Import', updatedAt: new Date(), observations: [],
    scoringStatus: 'scored', aimFitScore: 87, reqFitScore: 84, fitScore: 55, jdBatchId: null };
  let saved: Record<string, unknown> = { ...old };
  const writes: Record<string, unknown>[] = [];
  const url = `https://jobs.lever.co/acme/${id}?ref=joe`;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', () => { const error = new Error('Offline'); error.name = 'AbortError'; throw error; });
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findUnique', async () => ({ ...saved }));
  replace(t, prisma.job, 'update', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { ...saved };
  });
  replace(t, prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { count: 1 };
  });
  replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  replace(t, prisma, '$executeRaw', async () => 0);
  replace(t, prisma, '$queryRaw', async () => [{ id: 'existing-score', jobId: old.id,
    evaluationType: 'standard', family: 'legacy', schemaVersion: 'career-dashboard-fit-result-v1',
    aimFitScore: old.aimFitScore, experienceFitScore: old.reqFitScore, passed: true,
    staleAt: null, staleReason: null, createdAt: old.updatedAt }]);
  const response = await POST(new Request('http://localhost/api/jobs/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, linkOnly: true, skipRescore: true }),
  }), { params: Promise.resolve({ id: old.id }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.url, url);
  assert.equal(result.job.canonicalUrl, url);
  assert.equal(result.job.userCanonicalUrl, url);
  assert.match(result.refreshWarning, /Link saved/);
  for (const key of ['title', 'company', 'description', 'status', 'tailoringStaged', 'scoringStatus', 'fitScore', 'aimFitScore', 'reqFitScore'] as const) {
    assert.equal(result.job[key], old[key]);
    assert.ok(writes.every(write => !(key in write)), `refresh must preserve ${key}`);
  }
});

test('a PDQ link refresh replaces republisher metadata and keeps the exact link and existing scores', async t => {
  const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
  const { prisma } = await import('../../src/lib/prisma');
  const uuid = '7aa0e661-47d6-4bf7-92d5-d480d50129f4';
  const url = `https://ats.rippling.com/pdq/jobs/${uuid}?ref=joe#details`;
  const description = 'Responsibilities: Enable existing partners, activate accounts and deliver partner training. Qualifications: Channel management experience. '.repeat(10);
  let saved: Record<string, unknown> = { id: 'saved-card', title: 'Partner Manager (m/f/d)', company: 'WFHSprint',
    description: 'Old scored description', url: 'https://wfhsprint.2q.unaux.com/job/partner-manager-7-2',
    status: 'applied', source: 'JSearch', updatedAt: new Date(), observations: [], scoringStatus: 'scored',
    aimFitScore: 67, reqFitScore: 84, jdBatchId: null };
  const writes: Record<string, unknown>[] = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { servername: string; path: string }, callback: (body: Readable) => void) => {
    assert.equal(options.servername, 'ats.rippling.com');
    const detail = options.path.startsWith('/api/');
    if (detail) assert.equal(options.path, `/api/v1/board/pdq/jobs/${uuid}`);
    const payload = detail ? JSON.stringify({ uuid, url: url.split('?')[0], name: 'Partner Manager', companyName: 'PDQ',
      workLocations: ['Remote (United States)'], description: { role: `<p>${description}</p>` } }) : '<html></html>';
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(payload)]),
        { statusCode: 200, headers: {}, rawHeaders: ['Content-Type', detail ? 'application/json' : 'text/html'] })));
    } });
  });
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findUnique', async () => ({ ...saved }));
  replace(t, prisma.job, 'update', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { ...saved };
  });
  replace(t, prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { count: 1 };
  });
  replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  replace(t, prisma, '$executeRaw', async () => 0);
  replace(t, prisma, '$queryRaw', async () => [{ id: 'existing-score', jobId: 'saved-card',
    evaluationType: 'standard', family: 'legacy', schemaVersion: 'career-dashboard-fit-result-v1',
    aimFitScore: 67, experienceFitScore: 84, passed: true, staleAt: null, staleReason: null, createdAt: new Date() }]);
  replace(t, prisma.atsCompany, 'findMany', async () => [{ slug: 'pdq', platform: 'rippling', status: 'active' }]);
  replace(t, prisma.atsCompany, 'update', async () => ({}));
  const response = await POST(new Request('http://localhost/api/jobs/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, linkOnly: true, skipRescore: true }),
  }), { params: Promise.resolve({ id: 'saved-card' }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.company, 'PDQ');
  assert.equal(result.job.title, 'Partner Manager');
  assert.equal(result.job.description, description.trim());
  assert.equal(result.job.url, url);
  assert.equal(result.job.canonicalUrl, url);
  assert.equal(result.job.aimFitScore, 67);
  assert.equal(result.job.reqFitScore, 84);
  assert.equal(result.job.status, 'applied');
  assert.equal(result.rescoreQueued, false);
  assert.equal(result.scoreInvalidated, false);
  assert.ok(writes.every(write => !('aimFitScore' in write) && !('reqFitScore' in write)));
});
