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
    description: '<p>join the team in Stockholm</p>',
  }]);
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
        description: 'stored body',
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
  assert.equal(fetched, 0, 'a stored hit must not cost a network request');
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
