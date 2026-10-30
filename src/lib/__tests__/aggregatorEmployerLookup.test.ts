import assert from 'node:assert/strict';
import test from 'node:test';
import { findStoredAtsPostings, resolveDirectAtsPosting, selectDirectAtsMatch, type BoardPosting } from '../atsDirectMatch';
import { resolveExternalDirectAtsPosting } from '../jobIngestion';

const incoming = {
  title: 'Brand Partnerships Lead', company: 'Pinterest', location: 'Chicago, IL',
  source: 'Himalayas', url: 'https://himalayas.app/companies/pinterest/jobs/brand-partnerships-lead',
  description: 'Aggregator description.',
};
const board = (slug = 'pinterest') => ({ platform: 'greenhouse', slug, status: 'active' });
const posting = (slug: string, id: number, location: string | null): BoardPosting => ({
  title: incoming.title, url: `https://job-boards.greenhouse.io/${slug}/jobs/${id}`, location, description: null,
});
function storeFor(boards = [board()], stored: BoardPosting[] = [], companyName = 'Pinterest') {
  return {
    job: { findMany: async () => stored.map(item => ({ ...item, company: 'Pinterest', source: 'ATS-greenhouse' })) },
    companyNameRule: { findMany: async () => [
      { matchType: 'employer', matchKey: 'pinterestinc', standardName: 'Pinterest', origin: 'learned' },
    ] },
    employerAtsBoard: { findMany: async (args: { where: unknown }) => {
      assert.match(JSON.stringify(args.where), /companyName/);
      return boards.map(item => ({ ...item, companyName, evidenceUrl: 'https://www.pinterest.com/careers/' }));
    } },
    atsCompany: { findMany: async () => boards },
  } as unknown as Parameters<typeof findStoredAtsPostings>[1];
}
function fetchCatalogues(catalogues: Record<string, BoardPosting[] | number>) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const slug = new URL(String(input)).pathname.split('/')[3];
    requests.push(slug);
    const catalogue = catalogues[slug];
    assert.notEqual(catalogue, undefined, `Unexpected board request: ${slug}`);
    if (typeof catalogue === 'number') return new Response('', { status: catalogue });
    return Response.json({ jobs: catalogue.map(item => ({
      title: item.title, absolute_url: item.url, location: { name: item.location }, content: item.description,
    })), meta: { total: catalogue.length } });
  }) as NonNullable<Parameters<typeof resolveDirectAtsPosting>[1]['fetcher']>;
  return { requests, fetcher };
}

test('verified employer discovery supplies the board before any direct jobs are stored', async () => {
  const fixture = fetchCatalogues({ pinterest: [posting('pinterest', 1, 'Chicago, Illinois')] });
  const match = await resolveDirectAtsPosting(incoming, { store: storeFor(), fetcher: fixture.fetcher });
  assert.equal(match?.url, posting('pinterest', 1, '').url);
  assert.equal(match?.matchedVia, 'live');
  assert.deepEqual(fixture.requests, ['pinterest']);
});

test('verified mappings honor employer aliases and reject different companies or excluded boards', async () => {
  assert.equal((await findStoredAtsPostings('Pinterest', storeFor([board()], [], 'Pinterest Inc'))).boards.length, 1);
  assert.equal((await findStoredAtsPostings('Pinterest', storeFor([board()], [], 'Pinterest Consulting'))).boards.length, 0);
  assert.equal((await findStoredAtsPostings('Pinterest', storeFor([{ ...board(), status: 'excluded' }]))).boards.length, 0);
});

test('an existing direct posting is matched by title and location without fetching any board', async () => {
  const fixture = fetchCatalogues({});
  const match = await resolveDirectAtsPosting(incoming, {
    store: storeFor([board()], [posting('pinterest', 1, 'New York, NY'), posting('pinterest', 2, 'Chicago, IL')]),
    fetcher: fixture.fetcher,
  });
  assert.equal(match?.url, posting('pinterest', 2, '').url);
  assert.equal(match?.matchedVia, 'stored');
  assert.deepEqual(fixture.requests, []);
});

test('location separates identical titles across all verified employer boards', async () => {
  const fixture = fetchCatalogues({
    pinterest: [posting('pinterest', 1, 'New York, NY')],
    pinterestus: [posting('pinterestus', 2, 'Chicago, Illinois')],
  });
  const match = await resolveDirectAtsPosting(incoming, {
    store: storeFor([board(), board('pinterestus')]), fetcher: fixture.fetcher,
  });
  assert.equal(match?.url, posting('pinterestus', 2, '').url);
  assert.equal(match?.slug, 'pinterestus');
  assert.deepEqual(fixture.requests.sort(), ['pinterest', 'pinterestus']);
});

test('same-title ambiguity, broad geography, and failed boards preserve the entire aggregator input', async () => {
  for (const [location, second] of [
    ['Chicago, IL', [posting('pinterestus', 2, 'Chicago, IL')]],
    ['USA', [posting('pinterestus', 2, 'New York, NY')]],
    ['', [posting('pinterestus', 2, 'New York, NY')]],
    ['Chicago, IL', 429],
    ['Chicago, IL', 503],
  ] as Array<[string, BoardPosting[] | number]>) {
    const fixture = fetchCatalogues({ pinterest: [posting('pinterest', 1, 'Chicago, IL')], pinterestus: second });
    const candidate = { ...incoming, location };
    const result = await resolveExternalDirectAtsPosting(candidate, job => resolveDirectAtsPosting(job, {
      store: storeFor([board(), board('pinterestus')]), fetcher: fixture.fetcher,
    }));
    assert.equal(result, candidate);
  }
});

test('an empty or nonmatching board preserves the aggregator source and URL', async () => {
  for (const catalogue of [[], [posting('pinterest', 1, 'New York, NY')]]) {
    const fixture = fetchCatalogues({ pinterest: catalogue });
    const result = await resolveExternalDirectAtsPosting(incoming, job => resolveDirectAtsPosting(job, {
      store: storeFor(), fetcher: fixture.fetcher,
    }));
    assert.equal(result, incoming);
  }
});

test('a malformed or incomplete board cannot create a unique match across employer boards', async () => {
  for (const body of [
    { error: 'temporarily unavailable' },
    { jobs: [{ title: incoming.title, absolute_url: posting('pinterest', 1, '').url,
      location: { name: 'Chicago, IL' } }], meta: { total: 2 } },
  ]) {
    const match = await resolveDirectAtsPosting(incoming, {
      store: storeFor([board(), board('pinterestus')]), fetcher: (async () => Response.json(body)) as never,
    });
    assert.equal(match, null);
  }
});

test('location in the title also distinguishes same-title postings with broad location fields', () => {
  const candidates = [posting('pinterest', 1, 'Minneapolis, MN'), posting('pinterest', 2, 'Milwaukee, WI')];
  assert.equal(selectDirectAtsMatch({ ...incoming, title: `${incoming.title} - Milwaukee, WI`, location: 'USA' }, candidates)?.url,
    candidates[1].url);
  const titled = candidates.map(item => ({ ...item, title: `${item.title} - ${item.location}`, location: 'USA' }));
  assert.equal(selectDirectAtsMatch({ ...incoming, location: 'Minneapolis, MN' }, titled)?.url, candidates[0].url);
});

test('a successful empty second board permits a unique match while disabled live lookup makes no requests', async () => {
  const fixture = fetchCatalogues({ pinterest: [posting('pinterest', 1, 'Chicago, IL')], pinterestus: [] });
  const store = storeFor([board(), board('pinterestus')]);
  assert.ok(await resolveDirectAtsPosting(incoming, { store, fetcher: fixture.fetcher }));
  fixture.requests.length = 0;
  assert.equal(await resolveDirectAtsPosting(incoming, { store, fetcher: fixture.fetcher, allowLivePing: false }), null);
  assert.deepEqual(fixture.requests, []);
});
