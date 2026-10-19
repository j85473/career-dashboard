import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '../prismaClient';

import {
  COMPANY_ALIAS_RULE,
  COMPANY_EMPLOYER_URL_RULE,
  employerUrlKey,
  recordCompanyNameCorrection,
  standardizeIncomingCompany,
} from '../companyNameStandardization';

type Rule = { matchType: string; matchKey: string; standardName: string; provenanceJobId?: string | null };

function ruleStore(initial: Rule[] = []) {
  const rules = new Map(initial.map(rule => [`${rule.matchType}:${rule.matchKey}`, { ...rule }]));
  const companyNameRule = {
    findMany: async (args: { where: { OR: Array<{ matchType: string; matchKey: string }> } }) =>
      args.where.OR.map(key => rules.get(`${key.matchType}:${key.matchKey}`)).filter(Boolean),
    upsert: async (args: {
      where: { matchType_matchKey: { matchType: string; matchKey: string } };
      update: Omit<Rule, 'matchType' | 'matchKey'>;
      create: Rule;
    }) => {
      const key = args.where.matchType_matchKey;
      const id = `${key.matchType}:${key.matchKey}`;
      rules.set(id, rules.has(id) ? { ...key, ...args.update } : { ...args.create });
      return rules.get(id)!;
    },
  };
  return {
    rules,
    store: { companyNameRule } as unknown as Pick<Prisma.TransactionClient, 'companyNameRule'>,
  };
}

test('employer URL keys retain the tenant on shared ATS hosts', () => {
  assert.equal(
    employerUrlKey('https://eczy.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/39584'),
    'oracle:eczy.fa.us2.oraclecloud.com:site:cx_1',
  );
  assert.equal(employerUrlKey('https://acosta.jobs/minneapolis-mn/job/ABC/job'), 'host:acosta.jobs');
  assert.equal(employerUrlKey('https://boards.greenhouse.io/Karbon/jobs/123'), 'greenhouse:karbon');
  assert.equal(employerUrlKey('https://jobs.ashbyhq.com/linear/123'), 'ashby:linear');
  assert.equal(employerUrlKey('https://jobs.jobvite.com/example/job/123'), null);
  assert.equal(employerUrlKey('https://dejobs.org/minneapolis-mn/example/ABC/job'), null);
  assert.equal(employerUrlKey('not a url'), null);
});

test('reviewed Acosta aliases standardize before a persisted rule exists', async () => {
  const { store } = ruleStore();
  assert.equal(await standardizeIncomingCompany({
    company: 'Acosta Group',
    canonicalUrl: 'https://acosta.jobs/minneapolis-mn/example/ABC/job',
  }, store), 'Acosta');
});

test('reviewed Acosta employer sites standardize a new source label', async () => {
  const { store } = ruleStore();
  assert.equal(await standardizeIncomingCompany({
    company: 'Acosta Field Marketing Services',
    canonicalUrl: 'https://eczy.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/39584',
  }, store), 'Acosta');
});

test('canonical employer authority standardizes an unrelated incoming label', async () => {
  const { store } = ruleStore([{
    matchType: COMPANY_EMPLOYER_URL_RULE,
    matchKey: 'host:acosta.jobs',
    standardName: 'Acosta',
  }]);
  assert.equal(await standardizeIncomingCompany({
    company: 'Acosta Field Marketing Services',
    canonicalUrl: 'https://acosta.jobs/minneapolis-mn/example/ABC/job',
  }, store), 'Acosta');
});

test('conflicting alias and employer rules fail closed', async () => {
  const { store } = ruleStore([
    { matchType: COMPANY_ALIAS_RULE, matchKey: 'north star', standardName: 'North Star' },
    { matchType: COMPANY_EMPLOYER_URL_RULE, matchKey: 'host:northstar.jobs', standardName: 'Another Company' },
  ]);
  assert.equal(await standardizeIncomingCompany({
    company: 'North Star',
    canonicalUrl: 'https://northstar.jobs/opening/1234',
  }, store), 'North Star');
});

test('an explicit correction teaches both labels and employer URLs prospectively', async () => {
  const { store, rules } = ruleStore();
  await recordCompanyNameCorrection(store, {
    priorName: 'Acosta Group',
    standardName: 'Acosta',
    jobId: 'job-1',
    url: 'https://acosta.jobs/opening/1234',
    canonicalUrl: 'https://eczy.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/39584',
  });
  assert.equal(rules.get('alias:acosta group')?.standardName, 'Acosta');
  assert.equal(rules.get('alias:acosta')?.standardName, 'Acosta');
  assert.equal(rules.get('employer_url:host:acosta.jobs')?.standardName, 'Acosta');
  assert.equal(
    rules.get('employer_url:oracle:eczy.fa.us2.oraclecloud.com:site:cx_1')?.standardName,
    'Acosta',
  );
});

test('correcting an unresolved employer teaches its verified site without global placeholder aliases', async () => {
  const { store, rules } = ruleStore();
  await recordCompanyNameCorrection(store, {
    priorName: 'Unknown Company', priorEmployer: 'Apple', standardName: 'Crossmark Inc.',
    jobId: 'crossmark', url: 'https://acosta.jobs/opening/1234',
  });
  assert.equal(rules.get('employer_url:host:acosta.jobs')?.standardName, 'Crossmark Inc.');
  for (const rule of rules.values()) {
    assert.doesNotMatch(rule.matchKey, /unknown|apple/);
  }
  assert.equal(rules.get('label:crossmark inc.')?.standardName, 'Crossmark Inc.');
});

test('new imports ignore preexisting global placeholder aliases', async () => {
  const { store } = ruleStore([{ matchType: 'alias', matchKey: 'unknown', standardName: 'Apple' }]);
  assert.equal(await standardizeIncomingCompany({ company: 'Unknown Company', url: 'https://unrelated.example/jobs/1' }, store), 'Unknown Company');
});

test('generic Company imports stay unresolved without verified identity and cannot use a global Company alias', async () => {
  const { store } = ruleStore([{ matchType: 'alias', matchKey: 'company', standardName: 'Apple' }]);
  for (const company of ['Company', 'Company logo', 'Employer name', 'Organization']) {
    assert.equal(await standardizeIncomingCompany({ company, url: 'https://unrelated.example/jobs/1' }, store), 'Unknown Company');
  }
  assert.equal(await standardizeIncomingCompany({ company: 'Company', url: 'https://acosta.jobs/jobs/1' }, store), 'Acosta');
});

test('placeholder variants cannot become correction rules or their destinations', async () => {
  for (const priorName of ['Unknown', 'Unknown Company', 'Unknown Employer', 'N/A', 'Not specified', 'Not available', 'Manual Import', 'Company', 'Company logo', 'Employer', 'Organization']) {
    const { store, rules } = ruleStore();
    await recordCompanyNameCorrection(store, { priorName, standardName: 'Apple', jobId: 'apple' });
    assert.equal(rules.size, 3, priorName);
    await recordCompanyNameCorrection(store, { priorName: 'Apple', standardName: priorName, jobId: 'apple' });
    assert.equal(rules.size, 3, priorName);
  }
});
