import assert from 'node:assert/strict';
import test from 'node:test';
import { findStoredAtsPostings, selectDirectAtsMatch, type BoardPosting } from '../atsDirectMatch';
import type { EmployerRule } from '../employerIdentity';

type StoredPosting = BoardPosting & {
  id: string;
  company: string;
  employer: string | null;
  canonicalUrl: string | null;
  source: string;
  observations: Array<{ source: string; url: string }>;
};

function row(overrides: Partial<StoredPosting> = {}): StoredPosting {
  return {
    id: 'stored-1', title: 'Account Manager', company: 'Acme', employer: 'Acme',
    source: 'ATS-greenhouse', url: 'https://job-boards.greenhouse.io/acme/jobs/123456',
    canonicalUrl: null, location: 'Remote, United States', description: null,
    observations: [], ...overrides,
  };
}

type Query = { where?: Record<string, unknown>; skip?: number; take?: number;
  select?: { observations?: { where?: Record<string, unknown> } } };

// Apply the actual query predicates so a broad stub cannot hide retrieval
// failures before the canonical-employer comparison gets to see a row.
function matches(record: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR' || field === 'AND') {
      const clauses = Array.isArray(condition) ? condition : [condition];
      return field === 'OR'
        ? clauses.some(clause => matches(record, clause as Record<string, unknown>))
        : clauses.every(clause => matches(record, clause as Record<string, unknown>));
    }
    if (condition === null || typeof condition !== 'object') return record[field] === condition;
    const filter = condition as Record<string, unknown>;
    if ('some' in filter) return Array.isArray(record[field])
      && (record[field] as Record<string, unknown>[]).some(item => matches(item, filter.some as Record<string, unknown>));
    const normalize = (value: unknown) => filter.mode === 'insensitive' ? String(value ?? '').toLowerCase() : String(value ?? '');
    const actual = normalize(record[field]);
    if ('equals' in filter && actual !== normalize(filter.equals)) return false;
    if ('contains' in filter && !actual.includes(normalize(filter.contains))) return false;
    if ('startsWith' in filter && !actual.startsWith(normalize(filter.startsWith))) return false;
    if ('gt' in filter && actual <= normalize(filter.gt)) return false;
    if ('in' in filter && !(filter.in as unknown[]).some(value => actual === normalize(value))) return false;
    return true;
  });
}

function storedStore(records: StoredPosting[], rules: EmployerRule[] = []) {
  const queries: Query[] = [];
  const store = {
    job: { findMany: async (query: Query) => {
      queries.push(query);
      const found = records.filter(record => matches(record as unknown as Record<string, unknown>, query.where));
      return found.slice(query.skip || 0, (query.skip || 0) + (query.take || found.length)).map(record => ({
        ...record,
        observations: record.observations.filter(observation => matches(observation, query.select?.observations?.where)),
      }));
    } },
    companyNameRule: { findMany: async () => rules },
  } as unknown as Parameters<typeof findStoredAtsPostings>[1];
  return { store, queries };
}

test('recognized canonical ATS links on aggregator and manual cards are searchable', async () => {
  const records = [row({ source: 'Himalayas' }), row({ id: 'manual', source: 'Manual Import',
    url: 'https://jobs.lever.co/acme/18e12d92-d9ec-4388-a6cf-3c62d1369681' })];
  const fixture = storedStore(records);
  const found = await findStoredAtsPostings('Acme', fixture.store);
  assert.equal(found.postings.length, 2);
});

test('a verified canonical destination already saved on the card can repair its aggregator View Posting link', () => {
  const first = row();
  const other = row({ url: first.url.replace('123456', '765432') });
  assert.equal(selectDirectAtsMatch({ title: first.title, location: 'USA', canonicalUrl: first.url }, [first, other])?.url, first.url);
  assert.equal(selectDirectAtsMatch({ title: first.title, location: 'USA', canonicalUrl: 'https://himalayas.app/companies/acme/jobs/account-manager' }, [first, other]), null);
});

test('an ATS source observation supplies the direct link retained behind an aggregator card', async () => {
  const direct = 'https://job-boards.greenhouse.io/acme/jobs/765432';
  const fixture = storedStore([row({ source: 'JSearch', url: 'https://himalayas.app/companies/acme/jobs/account-manager',
    observations: [
      { source: 'Himalayas', url: 'https://himalayas.app/companies/acme/jobs/account-manager' },
      { source: 'ATS-greenhouse', url: direct },
    ],
  })]);
  const found = await findStoredAtsPostings('Acme', fixture.store);
  assert.deepEqual(found.postings.map(posting => posting.url), [direct]);
});

test('multiple ATS requisitions on one retained card remain ambiguous', async () => {
  const first = row().url;
  const second = first.replace('123456', '765432');
  for (const directCard of [false, true]) {
    const fixture = storedStore([row({ source: 'JSearch',
      url: directCard ? first : 'https://himalayas.app/companies/acme/jobs/account-manager',
      observations: [{ source: 'ATS-greenhouse', url: first }, { source: 'ATS-greenhouse', url: second }],
    })]);
    const found = await findStoredAtsPostings('Acme', fixture.store);
    assert.equal(found.postings.length, 2);
    assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, found.postings), null);
  }
});

test('canonical employer retrieval uses the existing equality index and refuses placeholder employers', async () => {
  const fixture = storedStore([row()]);
  await findStoredAtsPostings('Acme', fixture.store);
  const clauses = fixture.queries[0].where?.OR as Array<Record<string, unknown>>;
  assert.deepEqual(clauses.find(clause => 'employer' in clause), { employer: { equals: 'Acme' } });
  const missing = storedStore([row({ company: 'Unknown Company', employer: 'Unknown Company' })]);
  assert.deepEqual((await findStoredAtsPostings('Unknown Company', missing.store)).postings, []);
  assert.equal(missing.queries.length, 0);
});

test('ordinary aggregator destinations and different employers cannot become ATS candidates', async () => {
  const fixture = storedStore([
    row({ source: 'Himalayas', url: 'https://himalayas.app/companies/acme/jobs/account-manager' }),
    row({ id: 'different-employer', company: 'Acme Payroll', employer: 'Acme Payroll' }),
  ]);
  assert.deepEqual((await findStoredAtsPostings('Acme', fixture.store)).postings, []);
});

test('a stale aggregator canonical field cannot mask a direct raw URL, regardless of source label', async () => {
  for (const source of ['Himalayas', 'ATS-greenhouse']) {
    const direct = 'https://job-boards.greenhouse.io/acme/jobs/123456';
    const fixture = storedStore([row({ source, url: direct,
      canonicalUrl: 'https://himalayas.app/companies/acme/jobs/account-manager' })]);
    assert.deepEqual((await findStoredAtsPostings('Acme', fixture.store)).postings.map(posting => posting.url), [direct], source);
  }
});

test('learned aliases participate in the database query before employer equality is checked', async () => {
  const fixture = storedStore([row({ company: 'Progleasing', employer: null })], [
    { matchType: 'employer', matchKey: 'progleasing', standardName: 'Progressive Leasing', origin: 'learned' },
  ]);
  assert.equal((await findStoredAtsPostings('Progressive Leasing', fixture.store)).postings.length, 1);
});

test('an alias identity key also retrieves its source spelling with spaces', async () => {
  const fixture = storedStore([
    row({ company: 'Prog Leasing', employer: null }),
    row({ id: 'unrelated-stem', company: 'Prog Logistics', employer: null }),
  ], [
    { matchType: 'employer', matchKey: 'progleasing', standardName: 'Progressive Leasing', origin: 'learned' },
  ]);
  assert.equal((await findStoredAtsPostings('Progressive Leasing', fixture.store)).postings.length, 1);
});

test('a jobs-at employer alias never expands retrieval to every jobs-labelled employer', async () => {
  const fixture = storedStore([row({ company: 'Jobs at Acosta', employer: 'Acosta' })], [
    { matchType: 'employer', matchKey: 'jobsatacosta', standardName: 'Acosta', origin: 'learned' },
  ]);
  assert.equal((await findStoredAtsPostings('Acosta', fixture.store)).postings.length, 1);
  assert.doesNotMatch(JSON.stringify(fixture.queries), /"contains":"jobs"/);
});

test('employers with exactly 4000 postings and larger catalogues retain complete matching coverage', async () => {
  for (const count of [4_000, 4_001]) {
    const records = Array.from({ length: count }, (_, index) => row({ id: String(index).padStart(5, '0'),
      title: index === count - 1 ? 'Target Account Manager' : `Other Role ${index}`,
      url: `https://job-boards.greenhouse.io/acme/jobs/${index + 100_000}` }));
    const fixture = storedStore(records);
    const found = await findStoredAtsPostings('Acme', fixture.store);
    assert.equal(found.postings.length, count);
    assert.equal(selectDirectAtsMatch({ title: 'Target Account Manager', location: 'USA' }, found.postings)?.url,
      records.at(-1)!.url);
    assert.equal(fixture.queries.length, 11);
    assert.deepEqual(fixture.queries[1].where?.id, { gt: '00399' });
    assert.equal(fixture.queries[1].skip, undefined);
  }
});

const workday = 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/USA-Remote/Account-Manager_R12345';
const alternateWorkday = 'https://acme.wd5.myworkdaysite.com/recruiting/acme/External/job/USA-Remote/Account-Manager_R12345';

test('Workday host and locale variants of one requisition do not create ambiguity', () => {
  const found = selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
    row({ url: workday }), row({ url: alternateWorkday }), row({ url: workday.replace('/en-US/', '/fr-FR/') }),
  ]);
  assert.ok(found);
});

test('a Workday apply-page variant belongs to the same requisition', () => {
  assert.ok(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
    row({ url: workday }), row({ url: `${workday}/apply` }),
  ]));
});

test('Greenhouse host aliases preserve the preferred URL and never cross company slugs or posting IDs', () => {
  const preferred = 'https://job-boards.greenhouse.io/acme/jobs/123456';
  const alias = 'https://boards.greenhouse.io/acme/jobs/123456?gh_src=tracking';
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
    row({ url: preferred }), row({ url: alias }),
  ])?.url, preferred);
  for (const different of [alias.replace('/acme/', '/different/'), alias.replace('123456', '654321')]) {
    assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
      row({ url: preferred }), row({ url: different }),
    ]), null);
  }
});

test('Lever apply aliases retain the company and hosting region in posting identity', () => {
  const preferred = 'https://jobs.lever.co/acme/18e12d92-d9ec-4388-a6cf-3c62d1369681';
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
    row({ url: preferred }), row({ url: `${preferred}/apply` }),
  ])?.url, preferred);
  for (const different of [preferred.replace('/acme/', '/different/'), preferred.replace('jobs.lever', 'jobs.eu.lever')]) {
    assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA' }, [
      row({ url: preferred }), row({ url: different }),
    ]), null);
  }
});

test('description fallback also keeps the preferred URL before its retained host alias', () => {
  const description = 'This complete employer posting describes the role and requirements. '.repeat(30);
  const preferred = 'https://job-boards.greenhouse.io/acme/jobs/123456';
  assert.equal(selectDirectAtsMatch({ title: 'Aggregator Label', location: 'USA', description }, [
    row({ url: preferred, description }), row({ url: preferred.replace('job-boards.', 'boards.'), description }),
  ])?.url, preferred);
});

test('different Workday requisitions stay ambiguous even when their complete descriptions match', () => {
  const description = 'This complete employer posting describes the role and requirements. '.repeat(30);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA', description }, [
    row({ url: workday, description }), row({ url: workday.replace('R12345', 'R54321'), description }),
  ]), null);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA', description }, [
    row({ url: workday, description }), row({ url: workday.replace('acme.wd5', 'different.wd5'), description }),
  ]), null);
});

test('body fallback deduplicates URL aliases but cannot bypass an explicit title territory conflict', () => {
  const description = 'This complete employer posting describes the role and requirements. '.repeat(30);
  assert.ok(selectDirectAtsMatch({ title: 'Aggregator Label', location: 'USA', description }, [
    row({ url: workday, description }), row({ url: alternateWorkday, description }),
  ]));
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager - Milwaukee, WI', location: null, description }, [
    row({ title: 'Account Manager - Minneapolis, MN', description }),
  ]), null);
});

test('title spelling variants retain seniority and specialty distinctions', () => {
  assert.ok(selectDirectAtsMatch({ title: 'Sr. Account Mgr', location: 'USA' }, [
    row({ title: 'Senior Account Manager' }),
  ]));
  assert.ok(selectDirectAtsMatch({ title: 'Sales &amp; Partner Manager', location: 'USA' }, [
    row({ title: 'Sales and Partner Manager' }),
  ]));
  assert.equal(selectDirectAtsMatch({ title: 'Senior Account Manager', location: 'USA' }, [row()]), null);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager (US Government)', location: 'USA' }, [
    row({ title: 'Account Manager (US Commercial)' }),
  ]), null);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager (Remote Healthcare)', location: 'USA' }, [
    row({ title: 'Account Manager (Remote Education)' }),
  ]), null);
});

test('the exact Remote Job publisher suffix is removed without dropping country or specialty', () => {
  assert.ok(selectDirectAtsMatch({ title: 'Account Manager, Remote Job', location: 'USA' }, [row()]));
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager (Remote US)', location: null }, [
    row({ title: 'Account Manager (Remote Canada)', location: null }),
  ]), null);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager, Remote Job Healthcare', location: 'USA' }, [row()]), null);
});
