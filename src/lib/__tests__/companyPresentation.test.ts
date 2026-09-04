import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { companyDisplayGroupKey, companyDisplayName } from '../companyPresentation';
import { companyJobsWhere } from '../companyJobQuery';
import { companyIdentityKey } from '../companyIdentity';

test('existing Zoetis entities display the same brand while stored identity remains distinct', () => {
  const names = ['110 - Zoetis US LLC', '6J2 - Zoetis Services LLC', 'Zoetis', 'zoetis.wd5'];
  for (const name of names) assert.equal(companyDisplayName(name, 'ATS-workday'), 'Zoetis');
  assert.notEqual(companyIdentityKey(names[0]), companyIdentityKey(names[1]), 'display must not change scoring or lifecycle identity');
  assert.equal(companyDisplayGroupKey(names[0]), companyDisplayGroupKey(names[1]));
});

test('known spellings share readable names without guessing brand expansions', () => {
  for (const [original, display] of [
    ['rfsmart', 'RF-SMART'], ['RF-SMART', 'RF-SMART'], ['redwoodmaterials', 'Redwood Materials'],
    ['Power TakeOff, Inc.', 'Power TakeOff'], ['Fieldnation', 'Field Nation'],
    ['firstadvantage.wd5', 'First Advantage'], ['Graco Inc.', 'Graco'],
    ['Bolster Inc.', 'Bolster'], ['Bolster', 'Bolster'], ['  Alt   Legal ', 'Alt Legal'],
    ['3m.wd1', '3M'], ['eBay', 'eBay'], ['BDX', 'BDX'], ['The Honest Company', 'The Honest Company'],
    ['Zoetis Consulting', 'Zoetis Consulting'], ['Zinc', 'Zinc'],
  ]) assert.equal(companyDisplayName(original, 'ATS-workday'), display, original);
  assert.notEqual(companyDisplayGroupKey('Zoetis Consulting'), companyDisplayGroupKey('Zoetis'));
  assert.notEqual(companyDisplayGroupKey('Power TakeOff Services'), companyDisplayGroupKey('Power TakeOff'));
  assert.equal(companyDisplayName('forrester.wd501'), 'Forrester');
});

test('company navigation groups verified variants before pagination and excludes prefix collisions', async () => {
  let query: unknown;
  const store = { job: { groupBy: async (args: unknown) => {
    query = args;
    return ['Zoetis', '110 - Zoetis US LLC', '6J2 - Zoetis Services LLC', 'Zoetis Consulting'].map(company => ({ company }));
  } } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  assert.deepEqual(await companyJobsWhere('110 - Zoetis US LLC', store), {
    company: { in: ['Zoetis', '110 - Zoetis US LLC', '6J2 - Zoetis Services LLC'] },
  });
  assert.ok(!JSON.stringify(query).includes('status'), 'company browsing retains existing cross-status scope');
  assert.equal(await companyJobsWhere(null, store), null);
});
