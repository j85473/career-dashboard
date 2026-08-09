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

test('rejects a territory role explicitly assigned to eastern North Dakota', () => {
  const result = check(
    'Territory Sales Manager Eastern North Dakota',
    'Represent our services throughout eastern North Dakota, including Fargo and Grand Forks. Expected to travel up to 75% of the time.',
    'Fargo, ND, United States',
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'Non-local title territory rejected');
});

test('high travel and generic territory language do not override a specific non-local location', () => {
  const result = check(
    'Territory Sales Manager',
    'Build relationships throughout the assigned territory. Expected to travel up to 75% of the time.',
    'Fargo, ND, United States',
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'Location rejected (Fargo, ND, United States)');
});

test('outstate Minnesota is in range because high travel is a requirement', () => {
  const result = check(
    'Territory Manager',
    'Cover accounts throughout the region.',
    'Duluth, MN',
  );
  assert.equal(result.passes, true, result.reason);
});

test('an explicit non-local residency requirement still rejects a territory role', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory. Candidates must reside in the Atlanta metro area. Travel 50%.',
    'Atlanta, GA',
  );
  assert.equal(result.passes, false);
});

test('an explicit non-local onsite requirement still rejects a territory role', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory. This role is hybrid and requires three days per week onsite in our Dallas, TX office.',
    'Dallas, TX',
  );
  assert.equal(result.passes, false);
});

test('a desk-based non-local role without territory evidence is still rejected on location', () => {
  const result = check(
    'Inside Sales Representative',
    'Work from our Phoenix office supporting inbound customer calls.',
    'Phoenix, AZ',
  );
  assert.equal(result.passes, false);
});

test('a non-local role with a field title but no territory evidence is still rejected', () => {
  const result = check(
    'Channel Marketing Coordinator',
    'Support the marketing team with partner collateral and event logistics.',
    'Boston, MA',
  );
  assert.equal(result.passes, false);
});

test('international locations remain rejected regardless of territory language', () => {
  const result = check(
    'Territory Sales Manager',
    'Own a multi-state territory with 60% travel.',
    'London, UK',
  );
  assert.equal(result.passes, false);
});
