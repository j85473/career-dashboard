import assert from 'node:assert/strict';
import test from 'node:test';

import { passesPreFilter } from '../../src/lib/jobFiltering';

const base = {
  title: 'Enterprise Account Executive',
  company: 'Example',
  description: 'Own customer relationships and commercial growth.',
  location: '',
  url: 'https://example.com/job',
};

test('keeps unknown and nationally remote jobs for manual Aim', () => {
  for (const location of ['', 'United States', 'Remote (US)', 'Remote - Anywhere - USA', 'Home based - Worldwide']) {
    assert.equal(passesPreFilter({ ...base, location }).passes, true, location);
  }
});

test('Aim-owned preference evidence is never rejected by the structural pre-filter', () => {
  const fixtures = [
    { ...base, location: 'New York, NY' },
    { ...base, title: 'Part-Time Sales Representative', location: 'Remote' },
    { ...base, title: '1099 Sales Contractor', location: 'Minnesota' },
    { ...base, company: 'Insight Global', location: 'Remote' },
    { ...base, company: 'AT&T', title: 'Field Sales Representative', location: 'Remote (US)' },
    { ...base, company: 'Prompt Therapy Solutions Inc.', location: 'New York, NY', description: 'Part-time onsite hunter role.' },
    { ...base, location: 'Austin, TX', description: 'This hybrid role requires three days each week in our Austin office.' },
    { ...base, location: 'Remote - Texas', description: 'Candidates must reside in Texas.' },
    { ...base, title: 'Senior Solutions Engineer (DACH)', location: 'Remote' },
    { ...base, title: 'Territory Sales Manager - Texas/Oklahoma', location: 'Saint Paul, MN', description: 'Candidates must live in the assigned territory.' },
  ];
  for (const fixture of fixtures) {
    const result = passesPreFilter(fixture);
    assert.equal(result.passes, true, `${fixture.title}: ${result.reason}`);
    assert.doesNotMatch(result.reason, /priority|override/i);
  }
});

test('structural occupational exclusions remain bounded and company-neutral', () => {
  for (const title of [
    'Software Engineering Manager',
    'Senior Scientist',
    'Service Desk Manager',
    'Quality Control Analyst',
    'Claims Adjustor',
    'Controller (Remote US)',
    'Lead Public Relations',
  ]) {
    const result = passesPreFilter({ ...base, title, location: 'Remote (US)' });
    assert.equal(result.passes, false, `${title}: ${result.reason}`);
  }
  assert.equal(passesPreFilter({ ...base, title: 'Enterprise Sales Engineer', location: 'Remote (US)' }).passes, true);
});
