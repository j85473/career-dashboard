import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceMiles, jobMatchesLocation, resolveJobLocationFilter } from '../jobLocationSearch';

function filter(value: string, miles = '25') {
  const result = resolveJobLocationFilter(value, miles);
  assert.ok(result);
  return result;
}

test('ZIP centers preserve leading zeroes and accept ZIP+4', () => {
  assert.deepEqual(filter('02108-1234'), filter('02108'));
  assert.match(filter('02108').label, /Boston, MA 02108/);
  assert.deepEqual(filter('Minneapolis, MN 55405'), filter('55405'));
  assert.throws(() => filter('Minneapolis, WI 55405'), /state and ZIP code do not match/);
  assert.throws(() => filter('Duluth, MN 55405'), /city and ZIP code do not match/);
  assert.throws(() => filter('00000'), /Location not found/);
});

test('US cities, state abbreviations and state names resolve consistently', () => {
  assert.deepEqual(filter('Minneapolis, MN'), filter(' minneapolis Minnesota '));
  assert.deepEqual(filter('St. Paul, MN'), filter('Saint Paul MN'));
  assert.equal(filter('MN').label, 'Minnesota (entire state)');
  assert.deepEqual(filter('MN'), filter('Minnesota'));
  assert.throws(() => filter('Springfield'), /Add a state or ZIP code/);
  assert.throws(() => filter('London, UK'), /Location not found/);
});

test('nearby suburbs and cross-state locations use distance rather than city text', () => {
  const nearby = filter('55405');
  for (const city of ['Minneapolis, MN', 'St. Paul, Minnesota (Hybrid)', 'Bloomington, MN', 'Edina, MN', 'Eden Prairie, MN']) {
    assert.equal(jobMatchesLocation(city, nearby), true, city);
  }
  assert.equal(jobMatchesLocation('Chicago, IL', nearby), false);
  assert.equal(jobMatchesLocation('Hudson, WI', filter('Saint Paul, MN', '50')), true);
  assert.equal(jobMatchesLocation('Hudson, WI', filter('Saint Paul, MN', '5')), false);
});

test('each published job site can match, with country and work qualifiers retained correctly', () => {
  const nearby = filter('55405');
  assert.equal(jobMatchesLocation('Chicago, IL; Minneapolis, MN', nearby), true);
  assert.equal(jobMatchesLocation('Chicago, IL, Minneapolis, MN', nearby), true);
  assert.equal(jobMatchesLocation('Remote - Minneapolis, MN, United States', nearby), true);
  assert.equal(jobMatchesLocation('US-MN-Minneapolis', nearby), true);
  for (const location of [null, '', 'Remote', 'United States', 'Unknown Location', 'Minnesota', 'Paris, France 55405', 'Minneapolis, KS']) {
    assert.equal(jobMatchesLocation(location, nearby), false, String(location));
  }
});

test('a state search includes that state but does not infer locations for remote-only jobs', () => {
  const state = filter('Minnesota');
  for (const location of ['MN', 'Remote, Minnesota', 'Duluth, MN', 'Minneapolis, MN', '55405']) {
    assert.equal(jobMatchesLocation(location, state), true, location);
  }
  for (const location of ['Remote', 'Hudson, WI', 'Canada', 'Unknown']) assert.equal(jobMatchesLocation(location, state), false);
});

test('invalid distance input never silently becomes an unfiltered search', () => {
  assert.equal(resolveJobLocationFilter('', null), null);
  assert.throws(() => resolveJobLocationFilter('', '25'), /Enter a city/);
  for (const radius of ['0', '-10', '501', 'NaN', 'Infinity']) assert.throws(() => filter('55405', radius), /between 1 and 500/);
  assert.throws(() => filter('x'.repeat(121)), /Enter a US city/);
});

test('straight-line miles are unrounded and give a stable radius boundary', () => {
  const a = { latitude: 45, longitude: -93 };
  const b = { latitude: 46, longitude: -93 };
  assert.equal(distanceMiles(a, a), 0);
  assert.ok(distanceMiles(a, b) > 69 && distanceMiles(a, b) < 70);
  assert.equal(distanceMiles(a, b), distanceMiles(b, a));
});
