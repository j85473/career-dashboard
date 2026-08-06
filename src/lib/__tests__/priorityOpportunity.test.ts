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
