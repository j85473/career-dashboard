import assert from 'node:assert/strict';
import test from 'node:test';
import { passesPreFilter } from '../../src/lib/jobFiltering';

const base = { title: 'Enterprise Account Executive', company: 'Example', description: '', location: '', url: 'https://example.com/job' };

test('keeps unknown and nationally remote jobs for scoring', () => {
  assert.equal(passesPreFilter(base).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'New York, NY', description: 'This is a fully remote role in the United States.' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'United States' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'Remote (US)' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'United States (Remote)' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'Home based - Worldwide' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'Remote (All US)' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'Remote (US Only)' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'United States (Remote-First)' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'Remote - Anywhere - USA' }).passes, true);
  assert.equal(passesPreFilter({
    ...base,
    location: 'Austin, TX',
    description: 'This is a home-based position. The account manager may live anywhere in the United States and travel through the Texas territory.',
  }).passes, true);
  assert.equal(passesPreFilter({
    ...base,
    location: 'Remote - United States',
    description: 'Quarterly travel to an onsite customer meeting in Austin may be required.',
  }).passes, true);
});

test('rejects clear non-target locations and explicit excluded employment types', () => {
  assert.equal(passesPreFilter({ ...base, location: 'New York, NY' }).passes, false);
  assert.equal(passesPreFilter({ ...base, title: 'Part-Time Sales Representative', location: 'Remote' }).passes, false);
  assert.equal(passesPreFilter({ ...base, title: '1099 Sales Contractor', location: 'Minnesota' }).passes, false);
  assert.equal(passesPreFilter({ ...base, company: 'Insight Global', location: 'Remote' }).passes, false);
});

test('rejects only the AT&T Field Sales Representative job family', () => {
  const base = {
    description: 'Manage a local territory and meet customers in the field.',
    location: 'Remote (All US)',
    url: 'https://example.com/job',
  };

  const blocked = passesPreFilter({
    ...base,
    company: 'AT&T',
    title: 'Field Sales Representative',
  });
  assert.equal(blocked.passes, false);
  assert.match(blocked.reason, /AT&T Field Sales Representative/i);

  assert.equal(passesPreFilter({
    ...base,
    company: 'AT&T',
    title: 'Field Sales Manager',
  }).passes, true);

  assert.equal(passesPreFilter({
    ...base,
    company: 'Example Telecom',
    title: 'Field Sales Representative',
  }).passes, true);
});

test('allows Minneapolis-Saint Paul metro onsite and hybrid roles', () => {
  const locations = [
    'Minneapolis, MN',
    'St. Paul, MN',
    'Bloomington, MN',
    'Eden Prairie, MN',
    '55405',
  ];

  for (const location of locations) {
    const result = passesPreFilter({
      ...base,
      location,
      description: 'This is a hybrid role with three days each week in the office.',
    });
    assert.equal(result.passes, true, `${location}: ${result.reason}`);
  }
});

test('rejects non-local hybrid and onsite attendance requirements', () => {
  const cases = [
    {
      location: 'Austin, TX',
      description: 'This is a hybrid role with three days each week in our office.',
    },
    {
      location: 'United States',
      description: 'This hybrid position is based in Austin, TX and requires three days per week in the office.',
    },
    {
      location: 'Remote',
      description: 'Candidates must live within commuting distance of our Austin office and report onsite twice per week.',
    },
  ];

  for (const job of cases) {
    const result = passesPreFilter({ ...base, ...job });
    assert.equal(result.passes, false, `${job.location}: ${result.reason}`);
    assert.match(result.reason, /Non-local (?:hybrid|onsite|residency)/);
  }
});

test('does not mistake incidental remote vocabulary for a remote job', () => {
  const descriptions = [
    'Provide remote support tools to customers while working from our Austin office.',
    'Experience with remote monitoring software is preferred.',
    'The first interview will be conducted remotely.',
    'You will collaborate with remote teams across the business.',
  ];

  for (const description of descriptions) {
    const result = passesPreFilter({ ...base, location: 'Austin, TX', description });
    assert.equal(result.passes, false, `${description}: ${result.reason}`);
  }
});

test('honors explicit statements that remote work is unavailable', () => {
  const descriptions = [
    'Remote-only candidates will not meet the requirements of this position.',
    'This is not a remote role.',
    'Remote work is not available.',
  ];

  for (const description of descriptions) {
    const result = passesPreFilter({ ...base, location: 'Remote', description });
    assert.equal(result.passes, false, `${description}: ${result.reason}`);
  }
});

test('rejects remote jobs restricted to another state', () => {
  const cases = [
    {
      location: 'Remote - Texas',
      description: 'This is a fully remote role. Candidates must reside in Texas.',
    },
    {
      location: 'Remote',
      description: 'This remote position is only available to candidates who live in Texas.',
    },
    {
      location: 'Austin, TX (Remote)',
      description: 'Employees work from home and support accounts across the region.',
    },
  ];

  for (const job of cases) {
    const result = passesPreFilter({ ...base, ...job });
    assert.equal(result.passes, false, `${job.location}: ${result.reason}`);
  }
});

test('rejects an aggregator-localized job when the title names a non-local required territory', () => {
  const result = passesPreFilter({
    ...base,
    title: 'Territory Sales Manager - Texas/Oklahoma',
    location: 'Saint Paul, MN',
    description: 'Candidates must live within the territory they support. Prefer candidates near Dallas, Houston, Austin, or San Antonio.',
  });
  assert.equal(result.passes, false);
  assert.match(result.reason, /title territory.*residency/i);
});

test('rejects internationally restricted remote roles without a US option', () => {
  const cases = [
    { title: 'Senior Solutions Engineer (DACH)', location: 'Remote' },
    { title: 'Senior Pre-Sales Solutions Engineer - Europe', location: 'EU | Remote' },
    { title: base.title, location: 'Remote - Philippines' },
  ];

  for (const job of cases) {
    const result = passesPreFilter({ ...base, ...job });
    assert.equal(result.passes, false, `${job.title} / ${job.location}: ${result.reason}`);
  }

  assert.equal(passesPreFilter({
    ...base,
    title: 'Senior Solutions Engineer',
    location: 'Amsterdam; Remote - Europe; Remote - United States',
  }).passes, true);
});

test('does not treat a same-named city in another state as Minneapolis metro', () => {
  for (const location of ['Bloomington, IN', 'Crystal City']) {
    const result = passesPreFilter({
      ...base,
      location,
      description: 'This is a hybrid role.',
    });
    assert.equal(result.passes, false, location);
  }
});

test('rejects the reported non-target role families before weighted scoring', () => {
  const rejectedTitles = [
    'Software Engineering Manager',
    'Senior Scientist',
    'Service Desk Manager',
    'Quality Control Analyst',
    'Claims Adjustor',
    'Staff Forward Deployed AI Solutions Engineer',
    'Controller (Remote US)',
    'Lead Public Relations',
    'Account Executive, Public Relations (B2B Technology)',
    'Senior IT Operations Engineer',
  ];

  for (const title of rejectedTitles) {
    const result = passesPreFilter({ ...base, title, location: 'Remote (US)' });
    assert.equal(result.passes, false, `${title}: ${result.reason}`);
  }

  assert.equal(passesPreFilter({
    ...base,
    title: 'Enterprise Sales Engineer',
    location: 'Remote (US)',
  }).passes, true);
});
