import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWorkdayMatchPostings } from '../workdayDirectMatch';
import { selectDirectAtsMatch } from '../atsDirectMatch';

const job = { title: 'Account Manager', company: 'Acme', location: 'Minnesota' };
const posting = (id: number, title = job.title) => ({ title, externalPath: `/job/Minneapolis-MN/Account-Manager_R${id}`, bulletFields: ['REQ'] });
const detail = (title = job.title) => ({ hiringOrganization: { name: 'Acme' },
  jobPostingInfo: { title, jobReqId: 'REQ', location: 'Minneapolis, MN', jobDescription: '<p>Manage the named account portfolio.</p>' } });

test('Workday reads the full title search, then verifies the exact posting details', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => posting(i, i === 20 ? job.title : `Other ${i}`));
  const offsets: number[] = [];
  const result = await fetchWorkdayMatchPostings('acme.wd5::External', job, async (url, init) => {
    if (!url.endsWith('/jobs')) return detail();
    const body = JSON.parse(String(init?.body));
    offsets.push(body.offset);
    assert.equal(body.searchText, 'account');
    return { total: rows.length, jobPostings: rows.slice(body.offset, body.offset + 20) };
  });
  assert.deepEqual(offsets, [0, 20]);
  assert.equal(result?.length, 1);
  assert.equal(selectDirectAtsMatch(job, result!)?.url,
    'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Minneapolis-MN/Account-Manager_R20');
});

test('Workday keeps same-title rivals and rejects incomplete, repeated, or drifting pages', async () => {
  const rivals = await fetchWorkdayMatchPostings('acme.wd5::External', job,
    async url => url.endsWith('/jobs') ? { total: 2, jobPostings: [posting(1), posting(2)] } : detail());
  assert.equal(selectDirectAtsMatch(job, rivals!), null);
  for (const payload of [
    { total: 21, jobPostings: [posting(1)] },
    { total: 2, jobPostings: [posting(1), posting(1)] },
    { total: 201, jobPostings: [posting(1)] },
    { jobPostings: [] },
    { total: 1, jobPostings: [{ ...posting(1), externalPath: '/job/../../different' }] },
  ]) assert.equal(await fetchWorkdayMatchPostings('acme.wd5::External', job, async () => payload), null);
  let page = 0;
  assert.equal(await fetchWorkdayMatchPostings('acme.wd5::External', job, async () =>
    ++page === 1 ? { total: 21, jobPostings: Array.from({ length: 20 }, (_, i) => posting(i)) }
      : { total: 22, jobPostings: [posting(20), posting(21)] }), null);
});

test('Workday does not use renamed results, foreign employers, or mismatched detail identities', async () => {
  for (const body of [detail('Different title'), { ...detail(), jobPostingInfo: { ...detail().jobPostingInfo,
    externalUrl: 'https://other.wd5.myworkdayjobs.com/en-US/External/job/US/Account-Manager_R1' } }]) {
    assert.equal(await fetchWorkdayMatchPostings('acme.wd5::External', job,
      async url => url.endsWith('/jobs') ? { total: 1, jobPostings: [posting(1)] } : body), null);
  }
  assert.deepEqual(await fetchWorkdayMatchPostings('acme.wd5::External', job,
    async url => url.endsWith('/jobs') ? { total: 1, jobPostings: [posting(1)] }
      : { ...detail(), hiringOrganization: { name: 'Different employer' } }), []);
  assert.deepEqual(await fetchWorkdayMatchPostings('acme.wd5::External', job,
    async () => ({ total: 1, jobPostings: [posting(1, 'Different title')] })), []);
});
