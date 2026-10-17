import assert from 'node:assert/strict';
import test from 'node:test';
import { locationsCompatibleForDirectMatch as compatible } from '../directMatchLocation';

test('a posting matches any explicitly named site, including later comma-separated sites', () => {
  for (const location of [
    'Boston, MA; Minneapolis, MN',
    'Boston, MA | Minneapolis, MN',
    'Boston, MA or Minneapolis, MN',
    'Boston, MA, Minneapolis, MN',
    'Boston, MA, United States, Minneapolis, MN, United States',
  ]) {
    assert.equal(compatible('Minneapolis, MN', location), true, location);
    assert.equal(compatible(location, 'Minneapolis, Minnesota'), true, location);
    assert.equal(compatible('Milwaukee, WI', location), false, location);
  }
});

test('mixed country lists keep their US sites without making foreign-only postings domestic', () => {
  assert.equal(compatible('USA', 'Toronto, Canada; Minneapolis, MN'), true);
  assert.equal(compatible('Minneapolis, MN', 'Toronto, Canada; Minneapolis, MN'), true);
  assert.equal(compatible('USA', 'Canada; United States'), true);
  assert.equal(compatible('USA', 'Toronto, Canada; London, United Kingdom'), false);
  assert.equal(compatible('Saint Paul, MN', 'Toronto, Ontario'), false);
  assert.equal(compatible('USA', 'Remote, Canada'), false);
  assert.equal(compatible('Canada', 'Remote, Canada'), true);
});

test('a remote qualifier on a foreign city or country cannot become an unrestricted option', () => {
  for (const location of ['Canada / Remote', 'Remote / Canada', 'Toronto, Canada; Remote', 'Canada | Remote', 'Unknown; Canada']) {
    assert.equal(compatible('USA', location), false, location);
  }
  assert.equal(compatible('USA', 'Boston, MA; Remote, United States'), true);
});

test('matching city names still refuse conflicting explicit US states', () => {
  assert.equal(compatible('Portland, OR', 'Portland, ME'), false);
  assert.equal(compatible('Springfield, IL', 'Springfield, Massachusetts'), false);
  assert.equal(compatible('Kansas City, KS', 'Kansas City, MO'), false);
  assert.equal(compatible('Portland, Oregon', 'Portland, OR'), true);
  assert.equal(compatible('Portland OR', 'Portland, Oregon, United States'), true);
  assert.equal(compatible('Portland, OR', 'Portland, ME; Boston, MA'), false);
});

test('explicit state-first US locations are not interpreted as country prefixes', () => {
  assert.equal(compatible('IN-Indianapolis', 'Indianapolis, IN'), true);
  assert.equal(compatible('DE-Wilmington', 'Wilmington, DE'), true);
  assert.equal(compatible('DE-Wilmington', 'Wilmington, NC'), false);
});

test('country prefixes preserve the named US city and state', () => {
  assert.equal(compatible('USA - Austin, TX', 'Austin, Texas'), true);
  assert.equal(compatible('US, Minneapolis, Minnesota', 'Minneapolis, MN'), true);
  assert.equal(compatible('United States - Portland, OR', 'Portland, ME'), false);
  assert.equal(compatible('US, Minneapolis, Minnesota', 'Milwaukee, WI'), false);
});

test('an explicit statewide location agrees only with places in that state', () => {
  assert.equal(compatible('Minnesota, US', 'Minneapolis, MN'), true);
  assert.equal(compatible('US, Minnesota', 'St. Paul, Minnesota'), true);
  assert.equal(compatible('Remote - Minnesota', 'Minneapolis, MN'), true);
  assert.equal(compatible('Remote - Minnesota', 'Remote - California'), false);
  assert.equal(compatible('Minnesota, US', 'Portland, OR'), false);
  assert.equal(compatible('Minnesota, US', 'Minneapolis'), false);
});

test('existing broad scopes, missing fields, county spellings, and city safeguards remain intact', () => {
  assert.equal(compatible('USA', 'Remote, United States'), true);
  assert.equal(compatible('Minneapolis, MN', 'Remote, United States'), true);
  assert.equal(compatible('USA', null), true);
  assert.equal(compatible(null, 'Remote, Canada'), true);
  assert.equal(compatible('Worldwide', 'Remote, Canada'), true);
  assert.equal(compatible('Anywhere in the world', 'Minneapolis, MN'), true);
  assert.equal(compatible('Saint Paul, Ramsey County', 'St. Paul, MN'), true);
  assert.equal(compatible('Milwaukee, Milwaukee County', 'Minneapolis, MN'), false);
  assert.equal(compatible('Green Bay, Brown County', 'Minneapolis, MN'), false);
  assert.equal(compatible('New York, NY', 'New Orleans, LA'), false);
  assert.equal(compatible('Saint Paul, MN', 'Minneapolis, MN'), false);
});

test('unknown-location publisher labels provide no location constraint', () => {
  for (const unknown of ['Unknown Location', 'Location unknown', 'Location not specified', 'Not available', 'Multiple locations', '12 Locations', 'N/A']) {
    assert.equal(compatible(unknown, 'California, United States; Minnesota, United States'), true, unknown);
    assert.equal(compatible('Remote, Canada', unknown), true, unknown);
    assert.equal(compatible('USA', `${unknown}; Toronto, Canada`), false, unknown);
  }
});
