import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { companyJobOrderedPage } from '../companyJobOrder';

type FindManyArgs = {
  where: Prisma.JobWhereInput;
  orderBy: Prisma.JobOrderByWithRelationInput[];
  skip: number;
  take: number;
  select: { id: true };
};

function fixture(applicationCount: number, total: number) {
  const findManyCalls: FindManyArgs[] = [];
  const store = {
    job: {
      count: async ({ where }: { where: Prisma.JobWhereInput }) => (
        JSON.stringify(where).includes('"in":["applied","interviewing"]')
          ? applicationCount
          : total
      ),
      findMany: async (args: FindManyArgs) => {
        findManyCalls.push(args);
        const applicationQuery = JSON.stringify(args.where).includes('"in":["applied","interviewing"]');
        const prefix = applicationQuery ? 'application' : 'other';
        return Array.from({ length: args.take }, (_, index) => ({ id: `${prefix}-${args.skip + index + 1}` }));
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  return { store, findManyCalls };
}

test('company jobs put applied and interviewing rows first, newest first within each group', async () => {
  const { store, findManyCalls } = fixture(2, 6);
  const page = await companyJobOrderedPage({ company: 'Example' }, 4, 0, store);

  assert.deepEqual(page, {
    ids: ['application-1', 'application-2', 'other-1', 'other-2'],
    total: 6,
  });
  assert.deepEqual(findManyCalls.map(({ orderBy }) => orderBy), [
    [{ createdAt: 'desc' }, { id: 'asc' }],
    [{ createdAt: 'desc' }, { id: 'asc' }],
  ]);
  assert.match(JSON.stringify(findManyCalls[0].where), /"status":\{"in":\["applied","interviewing"\]\}/);
  assert.match(JSON.stringify(findManyCalls[1].where), /"status":\{"notIn":\["applied","interviewing"\]\}/);
});

test('company-job pagination crosses from applications into ordinary jobs without gaps', async () => {
  const { store, findManyCalls } = fixture(3, 8);
  const page = await companyJobOrderedPage({ company: 'Example' }, 4, 2, store);

  assert.deepEqual(page.ids, ['application-3', 'other-1', 'other-2', 'other-3']);
  assert.deepEqual(findManyCalls.map(({ skip, take }) => ({ skip, take })), [
    { skip: 2, take: 1 },
    { skip: 0, take: 3 },
  ]);
});

test('pages after the application group continue at the correct ordinary-job offset', async () => {
  const { store, findManyCalls } = fixture(2, 10);
  const page = await companyJobOrderedPage({ company: 'Example' }, 3, 5, store);

  assert.deepEqual(page.ids, ['other-4', 'other-5', 'other-6']);
  assert.deepEqual(findManyCalls.map(({ skip, take }) => ({ skip, take })), [
    { skip: 3, take: 3 },
  ]);
});
