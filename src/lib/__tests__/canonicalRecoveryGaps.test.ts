import assert from 'node:assert/strict';
import test from 'node:test';
import { findStoredAtsPostings, isDirectPostingUrl, normalizeDirectPostingUrl, selectDirectAtsMatch,
  resolveDirectAtsPostingFromCatalogue } from '../atsDirectMatch';
import { discoverEmployerBoards } from '../employerAtsDiscovery';
import type { safeExternalFetch } from '../safeExternalFetch';

test('valid iCIMS, Taleo, ADP and BrassRing job identities are recognized', () => {
  for (const url of [
    'https://careers-acme.icims.com/jobs/123/account-manager/job',
    'https://careers-acme.icims.com/jobs/123/job',
    'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=260000LK',
    'https://myjobs.adp.com/midcocareers?c=2212039&d=ExternalCareerSite&r=5001232476306',
    'https://sjobs.brassring.com/TGnewUI/Search/Home?partnerid=26350&siteid=6930#jobDetails=1434551_6930',
  ]) assert.equal(isDirectPostingUrl(url), true, url);
  for (const url of [
    'https://careers-acme.icims.com/jobs/search',
    'https://acme.taleo.net/careersection/2/jobdetail.ftl',
    'https://myjobs.adp.com/midcocareers?c=2212039',
    'https://sjobs.brassring.com/TGnewUI/Search/Home?partnerid=26350&siteid=6930',
    'https://rmkcdn.successfactors.com/a123/images/company-logo.svg',
    'https://rmkcdn.successfactors.com/a123/images/company-logo.png?jobId=123',
  ]) assert.equal(isDirectPostingUrl(url), false, url);
});

test('saved evidence survives crawl-yield exclusions and missing registration without reactivating boards', async () => {
  const url = 'https://jobs.ashbyhq.com/socure/f740e09f-c5ee-4eef-878e-a8b51d9737d4';
  for (const reason of ['out_of_territory: all located postings are outside Minnesota',
    'proven_unproductive: no jobs survived', null]) {
    const store = {
      job: { findMany: async () => [{ id: '1', title: 'Sales Enablement and Training Manager',
        company: 'Socure', employer: 'Socure', source: 'ATS-ashby', url, location: 'USA' }] },
      atsCompany: { findMany: async () => reason ? [{ platform: 'ashby', slug: 'socure', status: 'excluded', excludedReason: reason }] : [] },
    } as unknown as Parameters<typeof findStoredAtsPostings>[1];
    const result = await findStoredAtsPostings('Socure', store);
    assert.deepEqual(result.postings.map(row => row.url), [url]);
    assert.deepEqual(result.boards, []);
  }
});

test('official-site discovery supplies every Workday search with its title and employer', async () => {
  const names = ['Account Manager', 'Enablement Director'];
  const titles: string[] = [];
  const fetcher = (async (value: string | URL, init?: RequestInit) => {
    const url = String(value);
    if (url === 'https://acme.com/') return new Response('<a href="https://acme.wd5.myworkdayjobs.com/External">Careers</a>', { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/jobs')) {
      const search = JSON.parse(String(init?.body)).searchText;
      const title = search === 'account' ? names[0] : names[1]; titles.push(title);
      return Response.json({ total: 1, jobPostings: [{ title, externalPath: `/job/USA/${title.replaceAll(' ', '-')}_R${titles.length}`,
        bulletFields: [`R${titles.length}`] }] });
    }
    if (url.includes('/job/USA/')) {
      const id = url.split('_').at(-1)!;
      return Response.json({ hiringOrganization: { name: 'Acme' }, jobPostingInfo: {
        title: names[Number(id.slice(1)) - 1], jobReqId: id, location: 'USA', jobDescription: 'The exact employer role.' } });
    }
    return new Response('', { status: 404 });
  }) as typeof safeExternalFetch;
  const result = await discoverEmployerBoards({ website: 'https://acme.com/',
    jobs: names.map(title => ({ title, company: 'Acme', location: 'USA' })), fetcher });
  assert.deepEqual(titles, names);
  assert.equal(result.length, 1);
  assert.equal(result[0].matchCount, 2);
});

test('BrassRing fragments remain separate requisitions through normalization and pinned selection', () => {
  const base = 'https://sjobs.brassring.com/TGnewUI/Search/Home?partnerid=26350&siteid=6930';
  const rows = [123, 456].map(id => ({ title: 'Account Manager', location: 'USA', description: null, url: `${base}#jobDetails=${id}_6930` }));
  assert.equal(normalizeDirectPostingUrl(rows[0].url), rows[0].url);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, rows), null);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', canonicalUrl: rows[1].url }, rows)?.url, rows[1].url);
});

test('new live postings cannot erase saved rivals, including crawl-excluded evidence', async () => {
  const old = { title: 'Account Manager', location: 'USA', description: null, url: 'https://jobs.ashbyhq.com/acme/old' };
  const newer = { ...old, url: 'https://jobs.ashbyhq.com/acme/new' };
  const board = { platform: 'ashby', slug: 'acme' };
  const catalogue = { postings: [old], board, boards: [board], verificationRequiredUrls: [old.url] };
  const fetcher = (async () => Response.json({ jobs: [{ title: newer.title, jobUrl: newer.url, location: 'USA' }] })) as typeof safeExternalFetch;
  const match = await resolveDirectAtsPostingFromCatalogue({ title: old.title, company: 'Acme', location: 'USA', source: 'Jobicy' },
    catalogue, { store: { job: {} } as never, fetcher });
  assert.equal(match, null);
});

test('legacy ADP cross-tenant observations cannot seed unrelated employer boards', async () => {
  const base = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=05a572fb-c219-4638-a950-4ffa92e9ff56&ccId=19000101_000001&lang=en_US&jobId=567604';
  const other = base.replace('05a572fb-c219-4638-a950-4ffa92e9ff56', 'a6204b15-477f-48ea-a2e4-df09f28e9185');
  const store = { job: { findMany: async () => [{ id: '1', title: 'Account Manager', company: 'Acme', employer: 'Acme',
    source: 'ATS-adp', url: base, canonicalUrl: base, observations: [{ source: 'ATS-adp', url: other }] }] } };
  const result = await findStoredAtsPostings('Acme', store as never);
  assert.equal(result.boards.length, 1);
  assert.deepEqual(result.postings.map(row => row.url), [base]);
  assert.deepEqual(result.verificationRequiredUrls, [base]);
});
