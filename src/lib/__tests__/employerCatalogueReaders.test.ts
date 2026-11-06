import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchEmployerBoardPostings } from '../employerBoardPostings';
import { selectDirectAtsMatch } from '../atsDirectMatch';
import type { safeExternalFetch } from '../safeExternalFetch';

const row = (id: number) => `<job><id>${id}</id><title>Account Manager</title><description>Manage accounts.</description><url>https://acme.applytojob.com/apply/${id}/Account-Manager</url><city>Minneapolis</city><state>MN</state><country>US</country></job>`;
test('JazzHR uses the complete employer XML export and retains competing requisitions', async () => {
  const result = await fetchEmployerBoardPostings({ platform: 'jazzhr', slug: 'acme' },
    (async () => new Response(`<jobs><company>Acme</company>${row(1)}${row(2)}</jobs>`,
      { headers: { 'content-type': 'application/xml' } })) as typeof safeExternalFetch);
  assert.equal(result?.length, 2);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'MN' }, result!), null);
  for (const html of ['<html>Request blocked</html>', `<jobs>${row(1)}</jobs>`]) {
    assert.equal(await fetchEmployerBoardPostings({ platform: 'jazzhr', slug: 'acme' },
      (async () => new Response(html)) as typeof safeExternalFetch), null);
  }
});

const clearBoard = { platform: 'clearcompany', slug: '10000000-0000-0000-0000-000000000001' };
const clearRow = (id: number) => ({ id, title: 'Account Manager', brandName: 'Acme', description: 'Manage accounts.',
  url: `https://jobs.clearcompany.com/jobs/${id}`, locations: [{ city: 'Minneapolis', subdivision: 'MN', country: 'US' }] });
test('additional paged catalogues require their reported total and reject repeated or failed continuation pages', async () => {
  for (const mode of ['complete', 'repeat', 'fail']) {
    const result = await fetchEmployerBoardPostings(clearBoard, (async (url: string | URL) => {
      const page = Number(new URL(String(url)).searchParams.get('pageIndex'));
      if (page === 1 && mode === 'fail') return new Response('', { status: 503 });
      return Response.json({ totalCount: 21, currentPageIndex: page,
        results: page === 0 ? Array.from({ length: 20 }, (_, id) => clearRow(id)) : [clearRow(mode === 'repeat' ? 0 : 20)] });
    }) as typeof safeExternalFetch);
    assert.equal(result?.length ?? null, mode === 'complete' ? 21 : null);
  }
});

test('ADP recovery uses one-based continuation and verifies the late candidate employer', async () => {
  const board = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=05a572fb-c219-4638-a950-4ffa92e9ff56&ccId=19000101_000001&lang=en_US';
  const offsets: string[] = [];
  const row = (id: number) => ({ requisitionTitle: id === 20 ? 'Account Manager' : `Other ${id}`,
    requisitionDescription: 'Manage accounts and partners. '.repeat(25),
    customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: String(id) }] } });
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('client-features')) return Response.json({ meta: { customFieldGroup: { stringFields: [
      { nameCode: { codeValue: 'ClientName' }, stringValue: 'Acme' },
    ] } } });
    if (!url.pathname.endsWith('job-requisitions')) return Response.json(row(20));
    offsets.push(url.searchParams.get('$skip') || '1');
    return Response.json({ meta: { totalNumber: 21 }, jobRequisitions: offsets.length === 1
      ? Array.from({ length: 20 }, (_, id) => row(id)) : [row(20)] });
  }) as typeof safeExternalFetch;
  const result = await fetchEmployerBoardPostings({ platform: 'adp', slug: board }, fetcher, 15000, undefined,
    { title: 'Account Manager', company: 'Acme' });
  assert.deepEqual(offsets, ['1', '21']);
  assert.equal(result?.length, 1);
  assert.equal(new URL(result![0].url).searchParams.get('jobId'), '20');
});
