import assert from 'node:assert/strict';
import test from 'node:test';

import { passesPreFilter } from '../jobFiltering';

function check(title: string, description: string, location: string) {
  return passesPreFilter({
    title,
    description,
    location,
    url: 'https://example.com/job',
    company: 'Example',
  });
}

test('a multi-state field territory role posted from a non-local HQ is not rejected on location', () => {
  const result = check(
    'Territory Sales Manager (Midwest USA)',
    'Own a multi-state territory across the upper Midwest. Travel 60% within the assigned territory.',
    'Michigan',
  );
  assert.equal(result.passes, true, result.reason);
});

test('a channel role covering a regional territory survives a non-local HQ location', () => {
  const result = check(
    'Partner Account Manager - Channel',
    'Manage authorized resellers across a multi-state territory. Up to 50% travel.',
    'Tyler, TX',
  );
  assert.equal(result.passes, true, result.reason);
});

test('routes an eastern North Dakota territory role to manual Aim', () => {
  const result = check(
    'Territory Sales Manager Eastern North Dakota',
    'Represent our services throughout eastern North Dakota, including Fargo and Grand Forks. Expected to travel up to 75% of the time.',
    'Fargo, ND, United States',
  );
  assert.equal(result.passes, true, result.reason);
});

test('routes specific non-local work-base evidence to manual Aim', () => {
  const result = check(
    'Territory Sales Manager',
    'Build relationships throughout the assigned territory. Expected to travel up to 75% of the time.',
    'Fargo, ND, United States',
  );
  assert.equal(result.passes, true, result.reason);
});

test('outstate Minnesota is in range because high travel is a requirement', () => {
  const result = check(
    'Territory Manager',
    'Cover accounts throughout the region.',
    'Duluth, MN',
  );
  assert.equal(result.passes, true, result.reason);
});

test('an explicit non-local residency requirement reaches manual Aim', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory. Candidates must reside in the Atlanta metro area. Travel 50%.',
    'Atlanta, GA',
  );
  assert.equal(result.passes, true, result.reason);
});

test('an explicit non-local onsite requirement reaches manual Aim', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory. This role is hybrid and requires three days per week onsite in our Dallas, TX office.',
    'Dallas, TX',
  );
  assert.equal(result.passes, true, result.reason);
});

test('a desk-based non-local role is not rejected upstream of Aim', () => {
  const result = check(
    'Inside Sales Representative',
    'Work from our Phoenix office supporting inbound customer calls.',
    'Phoenix, AZ',
  );
  assert.equal(result.passes, true, result.reason);
});

test('a non-local field title is not rejected upstream of Aim', () => {
  const result = check(
    'Channel Marketing Coordinator',
    'Support the marketing team with partner collateral and event logistics.',
    'Boston, MA',
  );
  assert.equal(result.passes, true, result.reason);
});

test('international work-base language reaches manual Aim', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory with 60% travel.',
    'London, UK',
  );
  assert.equal(result.passes, true, result.reason);
});

test('ButterflyMX-style US-remote work base is separate from a Western travel territory', () => {
  const result = check(
    'Regional Partner Manager - California Territory',
    'This is a fully remote role open to candidates across the United States. Manage a Western travel territory and visit partners up to 50% of the time.',
    'Remote – USA',
  );
  assert.equal(result.passes, true, result.reason);
});

test('Radformation-style global distributor travel remains eligible from a US work-at-home base', () => {
  const result = check(
    'Global Distribution Partner Manager',
    'Work at home while managing international distributor relationships. Travel to partner sites approximately 40% of the time.',
    'United States Work at Home',
  );
  assert.equal(result.passes, true, result.reason);
});

test('Purple Wave-style residence evidence reaches the closed Aim hard-stop policy', () => {
  const result = check(
    'Territory Manager - Eastern North Dakota',
    'Candidates must reside in Fargo or eastern North Dakota and travel throughout the territory up to 75% of the time.',
    'Remote - USA',
  );
  assert.equal(result.passes, true, result.reason);
});

test('Workday N Locations placeholder remains unknown rather than false-rejected', () => {
  const result = check(
    'Channel Sales Manager',
    'Own partner growth across an assigned multi-state territory. The role includes regular customer travel.',
    'N Locations',
  );
  assert.equal(result.passes, true, result.reason);
});

test('specific Minnesota cities and counties do not depend on a brittle city whitelist', () => {
  for (const location of ['Ely, MN', 'Olmsted County, Minnesota', 'Blue Earth County, MN']) {
    const result = check(
      'Territory Manager',
      'Manage customer relationships and territory growth throughout Minnesota.',
      location,
    );
    assert.equal(result.passes, true, `${location}: ${result.reason}`);
  }
});

test('international work-base language cannot be rejected before manual Aim', () => {
  for (const fixture of [
    {
      title: 'Channel Account Manager',
      description: 'This is a remote role, but candidates must reside in London, UK.',
      location: 'Remote',
    },
    {
      title: 'Partner Manager',
      description: 'This position is open across Canada and supports customers throughout the country.',
      location: 'Toronto, Canada',
    },
    {
      title: 'Account Manager',
      description: 'Employees may work anywhere Canada.',
      location: 'Remote',
    },
    {
      title: 'Account Manager',
      description: 'This remote policy lets us work anywhere Canada.',
      location: 'Remote',
    },
  ]) {
    const result = check(fixture.title, fixture.description, fixture.location);
    assert.equal(result.passes, true, `${fixture.location}: ${result.reason}`);
  }
});

test('assigned-territory residency is preserved for manual Aim', () => {
  const result = check(
    'Regional Partner Manager - California Territory',
    'This is remote, but the successful candidate must reside assigned territory.',
    'Remote - USA',
  );
  assert.equal(result.passes, true, result.reason);
});

test('distribution and insurance-sales titles are not structurally rejected', () => {
  for (const title of ['Distribution Manager', 'Branch Manager', 'Insurance Agent', 'Insurance Producer', 'Captive Consultant']) {
    const result = check(title, 'Own customer relationships and commercial growth.', 'Remote - USA');
    assert.equal(result.passes, true, `${title}: ${result.reason}`);
  }
});

test('Rochester Minnesota remains an eligible remote work base case-insensitively', () => {
  const result = check(
    'Territory Account Manager',
    'This remote role is based Rochester, mn and covers customer relationships across Minnesota.',
    'Remote',
  );
  assert.equal(result.passes, true, result.reason);
});
