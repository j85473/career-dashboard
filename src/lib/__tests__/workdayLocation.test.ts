import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkdayLocationsPlaceholder,
  parseWorkdayLocationFromPath,
  parseWorkdaySegment,
  resolveWorkdayPlaceholderLocation,
} from '../workdayLocation';

// Real /job/<segment>/ URLs from docs/prompts/workday-location-placeholder.md.
test('parses every documented URL segment', () => {
  assert.equal(
    parseWorkdayLocationFromPath('/job/Dallas-TX/NERC-P-C-Engineer_JR617'),
    'Dallas, TX',
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/Chicago-IL/Manager--Transmission-Market-A'),
    'Chicago, IL',
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/Plainville/Global-Manager--Project'),
    'Plainville',
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/Virtual---California/Key-Account-M'),
    'Virtual, California',
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/Phoenix-Office/Development-Engineering-Ma'),
    'Phoenix',
  );
});

test('a full state name suffix gets the same comma treatment as an abbreviation', () => {
  // The exact GFS "Outside Sales Representative" case the prompt doc cites
  // as the reason this collapses into one identityFingerprint.
  assert.equal(
    parseWorkdayLocationFromPath('/job/Youngstown-Ohio/Outside-Sales-Representative_R123'),
    'Youngstown, Ohio',
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/White-House-Tennessee/Outside-Sales-Representative_R124'),
    'White House, Tennessee',
  );
});

test('a multi-city segment fails closed rather than picking one city', () => {
  assert.equal(
    parseWorkdayLocationFromPath('/job/Champaign---Hazelwood/Sr-New-Produ'),
    null,
  );
});

test('a street address fails closed rather than being read as a city', () => {
  assert.equal(
    parseWorkdayLocationFromPath('/job/111-East-210th-Street/Emergency-Medicine_JR226338'),
    null,
  );
});

test('fails closed on inputs with no readable place', () => {
  assert.equal(parseWorkdayLocationFromPath(null), null);
  assert.equal(parseWorkdayLocationFromPath(undefined), null);
  assert.equal(parseWorkdayLocationFromPath(''), null);
  assert.equal(parseWorkdayLocationFromPath('/wday/cxs/acme/no-job-segment'), null);
  assert.equal(parseWorkdayLocationFromPath('/job//Untitled'), null);
  assert.equal(parseWorkdaySegment('12345'), null);
  assert.equal(parseWorkdaySegment('   '), null);
});

test('isWorkdayLocationsPlaceholder matches Workday\'s "<N> Locations" shape', () => {
  assert.equal(isWorkdayLocationsPlaceholder('2 Locations'), true);
  assert.equal(isWorkdayLocationsPlaceholder('51 locations'), true);
  assert.equal(isWorkdayLocationsPlaceholder('1 Location'), true);
  assert.equal(isWorkdayLocationsPlaceholder('Dallas, TX'), false);
  assert.equal(isWorkdayLocationsPlaceholder('Unknown Location'), false);
  assert.equal(isWorkdayLocationsPlaceholder(null), false);
  assert.equal(isWorkdayLocationsPlaceholder(undefined), false);
});

test('resolveWorkdayPlaceholderLocation only acts on the placeholder case', () => {
  // Not a placeholder: never touches a real location, even if the URL parses.
  assert.equal(
    resolveWorkdayPlaceholderLocation('Dallas, TX', '/job/Chicago-IL/Manager'),
    null,
  );
  assert.equal(
    resolveWorkdayPlaceholderLocation('Unknown Location', '/job/Dallas-TX/Engineer'),
    null,
  );
  // Placeholder with a readable segment: recovers the city.
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/Dallas-TX/Engineer'),
    'Dallas, TX',
  );
  // Placeholder with an unreadable segment: fails closed to null so the
  // caller keeps its existing placeholder text.
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/111-East-210th-Street/Job'),
    null,
  );
});
