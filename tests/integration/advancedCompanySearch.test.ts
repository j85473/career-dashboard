// Read-only regression against the configured database:
// node scripts/with-env.mjs node --import tsx --test tests/integration/advancedCompanySearch.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { GET } from '../../src/app/api/jobs/search/route';
import { prisma } from '../../src/lib/prisma';

let job: { id: string; title: string; company: string };
before(async () => {
  const existing = await prisma.job.findFirst({
    where: { status: 'applied', title: { not: '' }, company: { not: '' } },
    select: { id: true, title: true, company: true },
  });
  assert.ok(existing, 'requires an existing applied job; never creates or edits jobs');
  job = existing;
});
after(() => prisma.$disconnect());

async function search(params: Record<string, string>) {
  const response = await GET(new Request(`http://localhost/api/jobs/search?${new URLSearchParams(params)}`));
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  return data;
}

test('title and partial case-insensitive company filters require both to match', async () => {
  const title = job.title.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const company = job.company.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const result = await search({ q: title, field: 'title', companyQuery: `  ${company.toUpperCase()}  `, statuses: 'applied', limit: '50' });
  assert.ok(result.pagination.total > 0);
  for (const row of result.jobs) {
    for (const term of title.split(/\s+/)) assert.ok(row.title.toLowerCase().includes(term.toLowerCase()));
    for (const term of company.split(/\s+/)) assert.ok(row.company.toLowerCase().includes(term.toLowerCase()));
    assert.equal(row.status, 'applied');
  }
  const absent = await search({ q: title, field: 'title', companyQuery: 'no-such-company-583c7419', statuses: 'applied' });
  assert.equal(absent.pagination.total, 0);
});

test('company-only search and pagination honor the submitted employer filter', async () => {
  const company = job.company.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const params = { companyQuery: company, statuses: 'applied', limit: '1' };
  const first = await search(params);
  const second = await search({ ...params, page: '2' });
  assert.ok(first.pagination.total > 0);
  assert.equal(first.pagination.total, second.pagination.total);
  const ids = [...first.jobs, ...second.jobs].map((row: { id: string }) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('company constraints combine with exact IDs and description search', async () => {
  const absentCompany = 'no-such-company-583c7419';
  const direct = await search({ q: job.id, companyQuery: absentCompany });
  assert.equal(direct.pagination.total, 0);
  const description = await search({ q: 'sales', field: 'description', companyQuery: absentCompany, statuses: 'applied' });
  assert.equal(description.pagination.total, 0);
});
