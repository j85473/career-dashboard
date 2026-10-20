import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPromptHealthCompany,
  isPromptHealthPriorityRole,
  PROMPT_HEALTH_PRIORITY_BANNER,
} from '../priorityOpportunity';

test('Prompt Health company aliases are narrow and deterministic', () => {
  for (const company of [
    'Prompt',
    'Prompt Health',
    'Prompt Therapy Solutions',
    'Prompt Therapy Solutions Inc.',
    'PROMPT THERAPY SOLUTIONS, INC',
  ]) {
    assert.equal(isPromptHealthCompany(company), true, company);
  }

  for (const company of ['Prompt Engineering LLC', 'Promptly Health', 'Insight Global']) {
    assert.equal(isPromptHealthCompany(company), false, company);
  }
});

test('only Prompt Health account executive and account manager roles receive priority', () => {
  for (const title of [
    'Account Manager (SMB and Mid-Market, SaaS)',
    'Senior Account Executive',
    'Commercial AE',
  ]) {
    assert.equal(isPromptHealthPriorityRole({ title, company: 'Prompt Health' }), true, title);
  }

  assert.equal(isPromptHealthPriorityRole({ title: 'Clinical Operations Manager', company: 'Prompt Health' }), false);
  assert.equal(isPromptHealthPriorityRole({ title: 'Account Executive', company: 'Another Company' }), false);
  assert.match(PROMPT_HEALTH_PRIORITY_BANNER, /REAPPLY IMMEDIATELY/);
});

import {
  acostaPriorityInitialLifecycle,
  ACOSTA_CHANNEL_SALES_PRIORITY_REASON,
  isAcostaChannelSalesPriorityRole,
} from '../priorityOpportunity';
import { passesPreFilter } from '../jobFiltering';
import { evaluateAuthoritativeMetadata } from '../authoritativeMetadataGate';

const acostaRole = { title: 'Google Channel Sales Manager', company: 'Acosta' };

test('Acosta channel sales includes parent identities and verified Mosaic postings only', () => {
  for (const company of ['Acosta', 'Acosta Group', 'Acosta, Inc.', 'Jobs at Acosta', 'Mosaic North America', 'Mosaic Sales Solutions']) {
    assert.equal(isAcostaChannelSalesPriorityRole({ ...acostaRole, company }), true, company);
  }
  assert.equal(isAcostaChannelSalesPriorityRole({ title: 'Samsung CHANNEL   SALES Specialist', company: 'CROSSMARK', employer: 'Acosta' }), true);
  assert.equal(isAcostaChannelSalesPriorityRole({ ...acostaRole, company: 'Mosaic', url: 'https://eczy.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/39584' }), true);
  for (const company of ['Mosaic', 'The Mosaic Company', 'Mosaic Health', 'Acosta Verde', 'Not Acosta', 'Acosta Consulting']) {
    assert.equal(isAcostaChannelSalesPriorityRole({ ...acostaRole, company }), false, company);
  }
  for (const title of ['Regional Sales Manager', 'Channel Marketing Manager', 'Sales Channel Manager', 'Channel Salesperson']) {
    assert.equal(isAcostaChannelSalesPriorityRole({ ...acostaRole, title }), false, title);
  }
  for (const host of ['eczy-test.fa.us2.oraclecloud.com', 'eczy-dev3.fa.us2.oraclecloud.com', 'eczy.fa.us2.oraclecloud.com.evil.example']) {
    assert.equal(isAcostaChannelSalesPriorityRole({ ...acostaRole, company: 'Mosaic', url: `https://${host}/hcmUI/CandidateExperience/en/sites/CX_1/job/1` }), false);
  }
});

test('new priority arrivals go directly to Inbox without inventing scores', () => {
  assert.deepEqual(acostaPriorityInitialLifecycle(acostaRole), {
    status: 'inbox', scoringStatus: 'skipped', passReason: ACOSTA_CHANNEL_SALES_PRIORITY_REASON,
  });
  assert.equal(acostaPriorityInitialLifecycle(acostaRole, true), null, 'closed postings stay closed');
  assert.equal(acostaPriorityInitialLifecycle(acostaRole, false, true), null, 'applied duplicates stay protected');
  assert.equal(acostaPriorityInitialLifecycle({ ...acostaRole, company: 'Elsewhere' }), null);
});

test('any Acosta channel sales title bypasses normal title and geography triage', () => {
  const input = { ...acostaRole, title: 'Channel Sales Intern', location: 'London, United Kingdom', url: '', description: '' };
  assert.equal(passesPreFilter(input).passes, true);
  assert.equal(evaluateAuthoritativeMetadata(input).passes, true);
  assert.equal(passesPreFilter({ ...input, company: 'Unrelated' }).passes, false);
  assert.equal(evaluateAuthoritativeMetadata({ ...input, company: 'Unrelated' }).passes, false);
});
