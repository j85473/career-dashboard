import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHimalayasLinkRepair, himalayasCompanySlug, selectHimalayasEmployerPosting,
  type HimalayasRepairJob } from '../himalayasEmployerResolution';

const job: HimalayasRepairJob = {
  id: 'saved-job', title: 'Account Executive', company: 'Acme', location: 'USA',
  url: 'https://himalayas.app/companies/acme/jobs/account-executive', canonicalUrl: null,
  description: 'Saved scoring input', source: 'Himalayas', status: 'applied', updatedAt: new Date('2026-10-14T12:00:00Z'),
};
const posting = { title: 'Account Executive', location: 'Remote, United States',
  url: 'https://jobs.lever.co/acme/req-123', description: 'A different employer description' };

test('company keys require an exact Himalayas job URL', () => {
  assert.equal(himalayasCompanySlug(job.url), 'acme');
  assert.equal(himalayasCompanySlug('https://himalayas.app.evil.com/companies/acme/jobs/ae'), null);
  assert.equal(himalayasCompanySlug('https://example.com/companies/acme/jobs/ae'), null);
  assert.equal(himalayasCompanySlug('https://himalayas.app/companies/acme'), null);
});

test('ambiguity and geography disagreement leave existing cards unresolved', () => {
  assert.equal(selectHimalayasEmployerPosting(job, [posting, { ...posting, url: 'https://jobs.lever.co/acme/req-456' }]), null);
  assert.equal(selectHimalayasEmployerPosting(job, [{ ...posting, location: 'Canada' }]), null);
  assert.equal(selectHimalayasEmployerPosting({ ...job, status: 'dismissed' }, [posting]), null);
  assert.equal(selectHimalayasEmployerPosting({ ...job, source: 'Manual Import' }, [posting]), null);
  assert.equal(selectHimalayasEmployerPosting({ ...job, canonicalUrl: posting.url }, [posting]), null);
});

test('an applied card receives only a link repair, with concurrent edits protected', async () => {
  const writes: unknown[] = [];
  const store = { job: { updateMany: async (query: unknown) => { writes.push(query); return { count: 1 }; } } } as unknown as Parameters<typeof applyHimalayasLinkRepair>[2];
  assert.equal(await applyHimalayasLinkRepair(job, [posting], store), true);
  assert.deepEqual(writes, [{
    where: { id: job.id, updatedAt: job.updatedAt, source: { equals: 'Himalayas', mode: 'insensitive' },
      status: { in: ['inbox', 'pending_af', 'needs_jd', 'bookmarked', 'applied', 'interviewing'] }, url: job.url, canonicalUrl: null },
    data: { url: posting.url, canonicalUrl: posting.url },
  }]);
  const changed = { job: { updateMany: async () => ({ count: 0 }) } } as unknown as typeof store;
  assert.equal(await applyHimalayasLinkRepair(job, [posting], changed), false);
  writes.length = 0;
  assert.equal(await applyHimalayasLinkRepair(job, [posting, { ...posting, url: 'https://jobs.lever.co/acme/other' }], store), false);
  assert.deepEqual(writes, []);
});
