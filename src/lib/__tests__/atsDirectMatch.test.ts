import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  applyDirectMatchEnrichment,
  atsBoardRequest,
  boardIdentityFromUrl,
  findStoredAtsPostings,
  isAggregatorSource,
  locationsCompatibleForDirectMatch,
  parseBoardPostings,
  planDirectMatchEnrichment,
  resolveDirectAtsPosting,
  selectDirectAtsMatch,
  selectFullerAtsDescription,
  titleLocationSuffix,
  type BoardPosting,
  type DirectAtsMatch,
} from '../atsDirectMatch';

function posting(overrides: Partial<BoardPosting> = {}): BoardPosting {
  return {
    title: 'Customer Success Manager - Mid Market',
    url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
    location: 'Remote, United States',
    description: 'A much longer description than the aggregator supplied.',
    ...overrides,
  };
}

test('a board slug is read off a stored posting URL, never guessed from a name', () => {
  assert.deepEqual(
    boardIdentityFromUrl('https://job-boards.greenhouse.io/karbon/jobs/5481516004'),
    { platform: 'greenhouse', slug: 'karbon' },
  );
  assert.deepEqual(
    boardIdentityFromUrl('https://jobs.lever.co/aogarciaagency/00b24797'),
    { platform: 'lever', slug: 'aogarciaagency' },
  );
  assert.deepEqual(
    boardIdentityFromUrl('https://jobs.ashbyhq.com/bjakcareer/b1f92c52'),
    { platform: 'ashby', slug: 'bjakcareer' },
  );
  assert.deepEqual(
    boardIdentityFromUrl('https://sterkinmatches.recruitee.com/o/some-role'),
    { platform: 'recruitee', slug: 'sterkinmatches' },
  );
  assert.equal(boardIdentityFromUrl('https://jobicy.com/jobs/151321-customer-success-manager'), null);
  assert.equal(boardIdentityFromUrl('not a url'), null);
  assert.equal(boardIdentityFromUrl(null), null);
});

test('country separates two requisitions that share an exact title', () => {
  // The real Karbon board: the aggregator said "USA" and Greenhouse said
  // "Remote, United States" / "Remote, Canada".
  assert.equal(locationsCompatibleForDirectMatch('USA', 'Remote, United States'), true);
  assert.equal(locationsCompatibleForDirectMatch('USA', 'Remote, Canada'), false);
  assert.equal(locationsCompatibleForDirectMatch('Saint Paul, MN', 'Toronto, Ontario'), false);
  // A missing location on either side is not evidence of a mismatch.
  assert.equal(locationsCompatibleForDirectMatch('USA', null), true);
  assert.equal(locationsCompatibleForDirectMatch(null, 'Remote, Canada'), true);
});

test('the Karbon case resolves to the US requisition and not the Canadian one', () => {
  const match = selectDirectAtsMatch(
    { title: 'Customer Success Manager - Mid Market', location: 'USA' },
    [
      posting(),
      posting({ url: 'https://job-boards.greenhouse.io/karbon/jobs/6151754004', location: 'Remote, Canada' }),
      posting({ title: 'Customer Success Manager - SMB', location: 'Remote, United States' }),
    ],
  );
  assert.equal(match?.url, 'https://job-boards.greenhouse.io/karbon/jobs/6149696004');
});

test('ambiguity is refused rather than guessed', () => {
  // Two postings, same title, same country: nothing distinguishes them.
  const ambiguous = selectDirectAtsMatch(
    { title: 'Customer Success Manager - Mid Market', location: 'USA' },
    [
      posting({ url: 'https://job-boards.greenhouse.io/karbon/jobs/1' }),
      posting({ url: 'https://job-boards.greenhouse.io/karbon/jobs/2' }),
    ],
  );
  assert.equal(ambiguous, null);

  // Every candidate ruled out by geography is also a refusal.
  const wrongCountry = selectDirectAtsMatch(
    { title: 'Customer Success Manager - Mid Market', location: 'Saint Paul, MN' },
    [posting({ location: 'Remote, Canada' })],
  );
  assert.equal(wrongCountry, null);

  assert.equal(selectDirectAtsMatch({ title: 'Something Else', location: 'USA' }, [posting()]), null);
  assert.equal(selectDirectAtsMatch({ title: '', location: 'USA' }, [posting()]), null);
  // A candidate with no usable URL cannot be an apply target.
  assert.equal(selectDirectAtsMatch({ title: posting().title, location: 'USA' }, [posting({ url: '' })]), null);
});

test('a unique substantial description can repair an aggregator-renamed posting', () => {
  const body = `Panopto provides secure video management for education and enterprise teams. ${'Detailed employer posting text. '.repeat(45)}`;
  const match = selectDirectAtsMatch(
    { title: 'Senior Account Executive, EDU', location: 'Remote, United States', description: body },
    [
      posting({
        title: 'Senior Account Executive, Enterprise',
        url: 'https://jobs.lever.co/panopto/enterprise-role',
        description: `${body}\nOriginally posted on Himalayas.`,
      }),
      posting({ title: 'Account Executive, EDU', url: 'https://jobs.lever.co/panopto/edu-role', description: 'Different text '.repeat(100) }),
    ],
  );
  assert.equal(match?.url, 'https://jobs.lever.co/panopto/enterprise-role');
});

test('description fallback refuses short, ambiguous, and geographically incompatible evidence', () => {
  const body = 'Exact employer body. '.repeat(80);
  const renamed = { title: 'Aggregator label', location: 'Remote, United States', description: body };
  assert.equal(selectDirectAtsMatch(
    { ...renamed, description: 'Too short to identify a requisition.' },
    [posting({ title: 'Employer label', description: 'Too short to identify a requisition.' })],
  ), null);
  assert.equal(selectDirectAtsMatch(renamed, [
    posting({ title: 'Employer label A', url: 'https://jobs.lever.co/acme/a', description: body }),
    posting({ title: 'Employer label B', url: 'https://jobs.lever.co/acme/b', description: body }),
  ]), null);
  assert.equal(selectDirectAtsMatch(
    { ...renamed, location: 'Toronto, Canada' },
    [posting({ title: 'Employer label', location: 'Remote, United States', description: body })],
  ), null);
});

test('board responses parse from their real shapes', () => {
  // Shapes captured from the live APIs on 2026-08-25.
  const greenhouse = parseBoardPostings('greenhouse', {
    jobs: [{
      title: 'Customer Success Manager - Mid Market',
      absolute_url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
      location: { name: 'Remote, United States' },
      content: 'body text',
    }],
  }, 'karbon');
  assert.deepEqual(greenhouse, [{
    title: 'Customer Success Manager - Mid Market',
    url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
    location: 'Remote, United States',
    description: 'body text',
  }]);

  const lever = parseBoardPostings('lever', [{
    text: 'Benefits Services Representative - Remote',
    hostedUrl: 'https://jobs.lever.co/aogarciaagency/00b24797',
    categories: { location: 'Greater Sudbury, Ontario', team: 'Global Elite Empire Consultants' },
    descriptionPlain: 'lever body',
  }], 'aogarciaagency');
  assert.equal(lever[0].title, 'Benefits Services Representative - Remote');
  assert.equal(lever[0].location, 'Greater Sudbury, Ontario');
  // `categories.team` is a department, and has been mistaken for a title before.
  assert.notEqual(lever[0].title, 'Global Elite Empire Consultants');

  const smartrecruiters = parseBoardPostings('smartrecruiters', {
    content: [{
      id: '743999659847515',
      name: 'Firewall Analyst',
      company: { identifier: 'Mindlance2' },
      location: { city: 'Kennett Square', region: 'PA', fullLocation: 'Kennett Square, PA, United States' },
    }],
  }, 'mindlance2');
  assert.equal(smartrecruiters[0].url, 'https://jobs.smartrecruiters.com/Mindlance2/743999659847515');
  assert.equal(smartrecruiters[0].location, 'Kennett Square, PA, United States');

  // jobs.json is a bare JSON Feed keyed by `items`, not `jobs` -- confirmed
  // live against storytel.teamtailor.com on 2026-08-25. No location field
  // exists on the list item at all.
  const teamtailor = parseBoardPostings('teamtailor', {
    version: 'https://jsonfeed.org/version/1',
    items: [{
      id: 'e6342f46-f372-4858-94b2-6d2d8b8d7553',
      title: 'Senior Data Engineer',
      url: 'https://storytel.teamtailor.com/jobs/8090473-senior-data-engineer',
      date_published: '2026-07-18T16:18:08+02:00',
      content_html: '<p>join the team in Stockholm</p>',
    }],
  }, 'storytel');
  assert.deepEqual(teamtailor, [{
    title: 'Senior Data Engineer',
    url: 'https://storytel.teamtailor.com/jobs/8090473-senior-data-engineer',
    location: null,
    description: 'join the team in Stockholm',
  }]);
});

const descriptionAdapters: Array<{ platform: string; payload: (body: string) => unknown }> = [
  { platform: 'greenhouse', payload: (content) => ({ jobs: [{ content }] }) },
  { platform: 'lever', payload: (description) => [{ description }] },
  { platform: 'ashby', payload: (descriptionHtml) => ({ jobs: [{ descriptionHtml }] }) },
  { platform: 'recruitee', payload: (description) => ({ offers: [{ description }] }) },
  { platform: 'breezy', payload: (description) => [{ description }] },
  { platform: 'teamtailor', payload: (content_html) => ({ items: [{ content_html }] }) },
  { platform: 'pinpoint', payload: (description) => ({ data: [{ description }] }) },
];

for (const { platform, payload } of descriptionAdapters) {
  test(`${platform} matched descriptions remove ordinary and escaped HTML while retaining readable duties`, () => {
    const html = '<div><p>Grow R&amp;D partnerships.</p><ul><li>Travel &lt;10%.</li></ul></div>';
    const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const body of [html, escaped]) {
      assert.equal(
        parseBoardPostings(platform, payload(body), 'acme')[0].description,
        'Grow R&D partnerships.\n• Travel <10%.',
      );
    }
    assert.equal(parseBoardPostings(platform, payload('<div><br></div>'), 'acme')[0].description, null);
    assert.equal(parseBoardPostings(platform, payload('Plain role with <10% travel.'), 'acme')[0].description,
      'Plain role with <10% travel.');
  });
}

test('adapters with no description keep it absent', () => {
  for (const [platform, body] of [
    ['smartrecruiters', { content: [{ id: '1' }] }],
    ['workable', { results: [{ shortcode: '1' }] }],
    ['bamboohr', { result: [{ id: '1' }] }],
  ] as const) {
    assert.equal(parseBoardPostings(platform, body, 'acme')[0].description, null);
  }
});

test('plain descriptions from Lever and Ashby remain preferred over HTML fallbacks', () => {
  const body = { descriptionPlain: 'Plain duties.\nTravel <10%.', description: '<p>Fallback</p>', descriptionHtml: '<p>Fallback</p>' };
  assert.equal(parseBoardPostings('lever', [body], 'acme')[0].description, body.descriptionPlain);
  assert.equal(parseBoardPostings('ashby', { jobs: [body] }, 'acme')[0].description, body.descriptionPlain);
});

test('markup length cannot make a shorter ATS description replace a fuller one', () => {
  const current = 'Complete responsibilities, qualifications and benefits for the role.';
  const bloated = `<p class="${'layout '.repeat(100)}">Short stub.</p>`;
  assert.ok(bloated.length > current.length);
  assert.equal(selectFullerAtsDescription(current, bloated), null);
  assert.equal(selectFullerAtsDescription(current, `<p>${current}</p>`), null);
  assert.equal(selectFullerAtsDescription(current, '<div><br></div>'), null);
});

test('description selection compares readable text on both sides and returns only clean text', () => {
  const current = `<p class="${'layout '.repeat(100)}">Short stub.</p>`;
  const fuller = '<div><p>Full responsibilities and qualifications.</p><ul><li>Manage partners.</li></ul></div>';
  assert.equal(selectFullerAtsDescription(current, fuller),
    'Full responsibilities and qualifications.\n• Manage partners.');
  assert.equal(selectFullerAtsDescription(null, null), null);
});

test('existing-row enrichment uses readable length and saves no encoded markup', () => {
  const match: DirectAtsMatch = {
    ...posting(), platform: 'greenhouse', slug: 'acme', matchedVia: 'live',
    postingTitle: 'Partner Manager', postingLocation: 'USA',
    description: '&lt;p&gt;Full responsibilities and qualifications.&lt;/p&gt;',
  };
  const current = { url: match.url, canonicalUrl: match.url, description: 'Short stub.' };
  assert.deepEqual(planDirectMatchEnrichment(current, match), {
    url: match.url, canonicalUrl: match.url, description: 'Full responsibilities and qualifications.',
  });
  assert.equal(planDirectMatchEnrichment(current, {
    ...match, description: `<p class="${'layout '.repeat(100)}">Stub.</p>`,
  }), null);
});

test('an unrecognized platform or shape yields no candidates instead of bad ones', () => {
  assert.deepEqual(parseBoardPostings('workday', { jobs: [{ title: 'x' }] }, 'acme'), []);
  assert.deepEqual(parseBoardPostings('greenhouse', { unexpected: true }, 'acme'), []);
  assert.deepEqual(parseBoardPostings('greenhouse', null, 'acme'), []);
  assert.deepEqual(parseBoardPostings('lever', { not: 'an array' }, 'acme'), []);
});

test('only aggregator sources are resolved', () => {
  assert.equal(isAggregatorSource('Jobicy'), true);
  assert.equal(isAggregatorSource('Adzuna'), true);
  assert.equal(isAggregatorSource('Himalayas'), true);
  assert.equal(isAggregatorSource('ATS-greenhouse'), false);
  assert.equal(isAggregatorSource('careerforce'), true);
  assert.equal(isAggregatorSource('dejobs'), true);
  assert.equal(isAggregatorSource('Manual Import'), false);
  assert.equal(isAggregatorSource(null), false);
  assert.equal(isAggregatorSource(''), false);
});

test('enrichment touches the apply link and description, and nothing that identifies the job', () => {
  const match: DirectAtsMatch = {
    url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
    description: 'x'.repeat(10_793),
    platform: 'greenhouse',
    slug: 'karbon',
    matchedVia: 'live',
    postingTitle: 'Customer Success Manager - Mid Market',
    postingLocation: 'Remote, United States',
  };
  const plan = planDirectMatchEnrichment(
    { url: 'https://jobicy.com/jobs/151321', canonicalUrl: 'https://jobicy.com/jobs/151321', description: 'y'.repeat(6_510) },
    match,
  );
  assert.deepEqual(Object.keys(plan || {}).sort(), ['canonicalUrl', 'description', 'url']);
  assert.equal(plan?.url, match.url);
  assert.equal(plan?.canonicalUrl, match.url);
  // Scoring identity fields must never appear in an enrichment.
  for (const forbidden of ['title', 'company', 'location', 'status', 'scoringStatus', 'aimFitScore']) {
    assert.ok(!(forbidden in (plan || {})), `${forbidden} must not be enriched`);
  }
});

test('a shorter employer description is not treated as a correction', () => {
  const match: DirectAtsMatch = {
    url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
    description: 'short stub',
    platform: 'greenhouse', slug: 'karbon', matchedVia: 'live',
    postingTitle: 't', postingLocation: null,
  };
  const plan = planDirectMatchEnrichment(
    { url: 'https://jobicy.com/jobs/151321', canonicalUrl: 'https://jobicy.com/jobs/151321', description: 'y'.repeat(6_510) },
    match,
  );
  assert.deepEqual(Object.keys(plan || {}).sort(), ['canonicalUrl', 'url']);

  // Already pointing at the posting, with nothing better to add: no write.
  const noop = planDirectMatchEnrichment(
    { url: match.url, canonicalUrl: match.url, description: 'y'.repeat(6_510) },
    match,
  );
  assert.equal(noop, null);
});

test('the enrichment write is refused when the row changed underneath it', async () => {
  const seen: Array<{ where: Record<string, unknown>; data: unknown }> = [];
  const store = {
    job: {
      updateMany: async (args: { where: Record<string, unknown>; data: unknown }) => {
        seen.push(args);
        return { count: args.where.updatedAt ? 1 : 0 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const stamp = new Date('2026-08-25T00:00:00Z');
  const applied = await applyDirectMatchEnrichment('job-1', stamp, {
    url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
    canonicalUrl: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
  }, store);

  assert.equal(applied, true);
  assert.equal(seen[0].where.updatedAt, stamp, 'the concurrency guard must be in the predicate');
});

test('what we already store is preferred over spending a board request', async () => {
  let fetched = 0;
  const store = {
    job: {
      findMany: async () => [{
        title: 'Customer Success Manager - Mid Market',
        company: 'Karbon',
        url: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
        canonicalUrl: 'https://job-boards.greenhouse.io/karbon/jobs/6149696004',
        location: 'Remote, United States',
        description: '&lt;p&gt;stored body&lt;/p&gt;',
      }],
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const match = await resolveDirectAtsPosting(
    { title: 'Customer Success Manager - Mid Market', company: 'Karbon', location: 'USA', source: 'Jobicy' },
    {
      store,
      fetcher: (async () => { fetched += 1; return new Response('{}'); }) as never,
    },
  );

  assert.equal(match?.matchedVia, 'stored');
  assert.equal(match?.url, 'https://job-boards.greenhouse.io/karbon/jobs/6149696004');
  assert.equal(match?.description, 'stored body', 'a previous raw JD must not propagate into another job');
  assert.equal(fetched, 0, 'a stored hit must not cost a network request');
});

test('live aggregator resolution returns the clean employer description', async () => {
  const store = { job: { findMany: async () => [{
    ...posting({ title: 'Different role' }), company: 'Karbon',
  }] } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  const match = await resolveDirectAtsPosting(
    { title: posting().title, company: 'Karbon', location: 'USA', source: 'Himalayas' },
    { store, fetcher: (async () => Response.json({ jobs: [{
      title: posting().title, absolute_url: posting().url, location: { name: 'Remote, United States' },
      content: '&lt;p&gt;Manage partner relationships.&lt;/p&gt;',
    }] })) as never },
  );
  assert.equal(match?.matchedVia, 'live');
  assert.equal(match?.url, posting().url);
  assert.equal(match?.description, 'Manage partner relationships.');
});

test('stored ATS lookup narrows legal-name aliases but authorizes only canonical equality', async () => {
  let where: unknown = null;
  const store = {
    job: {
      findMany: async (args: { where: unknown }) => {
        where = args.where;
        return [
          {
            title: 'Key Account Manager',
            company: 'sharkninjaoperatingllc',
            url: 'https://job-boards.greenhouse.io/sharkninja/jobs/1',
            canonicalUrl: null,
            location: 'Minneapolis, MN',
            description: 'matching employer',
          },
          {
            title: 'Robotics Account Manager',
            company: 'Shark Robotics',
            url: 'https://job-boards.greenhouse.io/sharkrobotics/jobs/2',
            canonicalUrl: null,
            location: 'Minneapolis, MN',
            description: 'substring collision',
          },
        ];
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const result = await findStoredAtsPostings('SharkNinja', store);
  assert.equal(result.postings.length, 1);
  assert.equal(result.postings[0].title, 'Key Account Manager');
  assert.match(JSON.stringify(where), /contains/);
  assert.match(JSON.stringify(where), /sharkninja/i);
});

test('an ATS-sourced job is never resolved against itself', async () => {
  let queried = false;
  const store = {
    job: { findMany: async () => { queried = true; return []; } },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const match = await resolveDirectAtsPosting(
    { title: 'Fullstack Engineer', company: 'karbon', location: 'USA', source: 'ATS-greenhouse' },
    { store },
  );
  assert.equal(match, null);
  assert.equal(queried, false);
});

test('stored lookup accepts compact brand spellings but rejects a truncated candidate set', async () => {
  for (const [wanted, stored] of [['RF-SMART', 'rfsmart'], ['Redwood Materials', 'redwoodmaterials']]) {
    const store = { job: { findMany: async () => [{ ...posting(), company: stored }] } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
    assert.equal((await findStoredAtsPostings(wanted, store)).postings.length, 1);
  }
  const store = { job: { findMany: async () => Array.from({ length: 401 }, () => ({ ...posting(), company: 'RF-SMART' })) } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  assert.equal((await findStoredAtsPostings('RF-SMART', store)).postings.length, 0);
});

test('a company we hold no ATS postings for is refused without a board guess', async () => {
  const store = {
    job: { findMany: async () => [] },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const match = await resolveDirectAtsPosting(
    { title: 'Account Executive', company: 'Some Startup', location: 'USA', source: 'Adzuna' },
    { store, fetcher: (async () => { throw new Error('must not fetch'); }) as never },
  );
  assert.equal(match, null);
});

test('two different US cities are not the same posting', () => {
  // Four Adzuna "Specialty Representative, Rheumatology - Milwaukee, WI"
  // listings matched AbbVie's Minneapolis requisition in the first dry run:
  // normalizeTitle strips the trailing city from both titles, so geography was
  // the only separator left and it was not being enforced.
  assert.equal(locationsCompatibleForDirectMatch('Milwaukee, Milwaukee County', 'Minneapolis, MN'), false);
  assert.equal(locationsCompatibleForDirectMatch('Green Bay, Brown County', 'Minneapolis, MN'), false);
  assert.equal(locationsCompatibleForDirectMatch('New York, NY', 'New Orleans, LA'), false);
  // The same place written two ways still matches.
  assert.equal(locationsCompatibleForDirectMatch('Saint Paul, Ramsey County', 'St. Paul, MN'), true);
  // A national or remote scope cannot contradict a city.
  assert.equal(locationsCompatibleForDirectMatch('USA', 'Remote, United States'), true);
  assert.equal(locationsCompatibleForDirectMatch('Minneapolis, MN', 'Remote, United States'), true);
});

test('titles equal only after their territories were stripped are not a match', () => {
  assert.equal(titleLocationSuffix('Specialty Representative, Rheumatology - Milwaukee, WI'), 'milwaukee wi');
  assert.equal(titleLocationSuffix('Specialty Representative, Rheumatology - Minneapolis, MN'), 'minneapolis mn');
  assert.equal(titleLocationSuffix('Customer Success Manager - Mid Market'), null);

  // Even with a location field that says nothing, the stripped territories
  // disagree, so this must refuse.
  const refused = selectDirectAtsMatch(
    { title: 'Specialty Representative, Rheumatology - Milwaukee, WI', location: null },
    [posting({
      title: 'Specialty Representative, Rheumatology - Minneapolis, MN',
      location: 'Minneapolis, MN',
      url: 'https://jobs.smartrecruiters.com/abbvie/3743990014106736',
    })],
  );
  assert.equal(refused, null);

  // The same territory in both titles still resolves.
  const matched = selectDirectAtsMatch(
    { title: 'Specialty Representative, Rheumatology - Milwaukee, WI', location: 'Milwaukee, Milwaukee County' },
    [posting({
      title: 'Specialty Representative, Rheumatology - Milwaukee, WI',
      location: 'Milwaukee, WI',
      url: 'https://jobs.smartrecruiters.com/abbvie/999',
    })],
  );
  assert.equal(matched?.url, 'https://jobs.smartrecruiters.com/abbvie/999');
});

test('workable posts its query and composes URLs from the shortcode', () => {
  const request = atsBoardRequest('workable', 'ananinja');
  assert.equal(request?.init?.method, 'POST', 'workable is the one board that refuses a GET');
  assert.match(String(request?.url), /apply\.workable\.com\/api\/v3\/accounts\/ananinja\/jobs$/);

  const parsed = parseBoardPostings('workable', {
    results: [{
      title: 'Dispatch Agent',
      shortcode: '4EF89F59F1',
      location: { city: 'Riyadh', country: 'Saudi Arabia', countryCode: 'SA' },
    }],
  }, 'ananinja');
  assert.deepEqual(parsed, [{
    title: 'Dispatch Agent',
    url: 'https://apply.workable.com/ananinja/j/4EF89F59F1/',
    location: 'Riyadh, Saudi Arabia',
    description: null,
  }]);
});

test('bamboohr parses its careers list', () => {
  assert.equal(atsBoardRequest('bamboohr', 'orag')?.init, undefined);
  const parsed = parseBoardPostings('bamboohr', {
    result: [{
      id: '2911',
      jobOpeningName: 'Product Advisor - OpenRoad Audi Boundary',
      location: { city: 'Burnaby', state: 'British Columbia' },
    }],
  }, 'orag');
  assert.deepEqual(parsed, [{
    title: 'Product Advisor - OpenRoad Audi Boundary',
    url: 'https://orag.bamboohr.com/careers/2911',
    location: 'Burnaby, British Columbia',
    description: null,
  }]);
});
