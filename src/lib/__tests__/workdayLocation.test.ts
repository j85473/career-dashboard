import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeMultiSiteLocation,
  isWorkdayLocationsPlaceholder,
  parseWorkdayLocationFromPath,
  parseWorkdaySegment,
  resolveWorkdayPlaceholderLocation,
} from '../workdayLocation';
import { isUnknownOrBroadUSOption, splitLocationOptions } from '../jobLocationPolicy';
import { acceptableLocationOption } from '../localTriage';

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

test('a country token is never read as the city', () => {
  // Real Litera data: "USA---New-Jersey" would otherwise parse as a
  // well-formed-looking "USA, New Jersey", which names no actual place.
  assert.equal(
    parseWorkdayLocationFromPath('/job/USA---New-Jersey/Account-Executive_R1'),
    null,
  );
  assert.equal(
    parseWorkdayLocationFromPath('/job/United-States-of-America-Georgia/Strategic-Account_R2'),
    null,
  );
});

test('a leading state abbreviation is read as State-City order, not a Washington-state suffix', () => {
  // Real newrez.wd1 data: the segment is "PA-Fort-Washington" (Fort
  // Washington, Pennsylvania). Reading the literal last token "Washington"
  // as the state would silently swap city and state.
  assert.equal(
    parseWorkdayLocationFromPath('/job/PA-Fort-Washington/Sr-Sales-Manager_R1'),
    'Fort Washington, PA',
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

test('composeMultiSiteLocation joins a clean primary with the verbatim placeholder', () => {
  assert.equal(
    composeMultiSiteLocation('Dallas, TX', '2 Locations'),
    'Dallas, TX; 2 Locations',
  );
  assert.equal(
    composeMultiSiteLocation('Youngstown, Ohio', '5 locations'),
    'Youngstown, Ohio; 5 locations',
  );
});

test('composeMultiSiteLocation fails closed when the primary has no state', () => {
  // The exact defect the multi-site prompt caught: "Ohio USA", "Plainville",
  // "Phoenix" (label-stripped) are all real parser outputs that are not a
  // confident single place, and none of them should be composed in as if
  // they were.
  for (const primary of ['Plainville', 'Phoenix', 'Ohio USA', 'Grand Rapids MI United States', '', null, undefined]) {
    assert.equal(
      composeMultiSiteLocation(primary, '2 Locations'),
      null,
      `primary ${JSON.stringify(primary)} should not compose`,
    );
  }
});

test('composeMultiSiteLocation fails closed when the second argument is not the placeholder', () => {
  assert.equal(composeMultiSiteLocation('Dallas, TX', 'Dallas, TX'), null);
  assert.equal(composeMultiSiteLocation('Dallas, TX', null), null);
});

test('the composed value still passes the geography gate', () => {
  // This is the whole point of composing rather than replacing: the second
  // option must still read as isUnknownOrBroadUSOption so a five-city
  // requisition whose primary is Ohio doesn't get withheld on the strength
  // of that one option, the way a bare "Ohio USA" primary would.
  const composed = composeMultiSiteLocation('Youngstown, Ohio', '2 Locations');
  assert.equal(composed, 'Youngstown, Ohio; 2 Locations');
  const options = splitLocationOptions(composed as string);
  assert.deepEqual(options, ['Youngstown, Ohio', '2 Locations']);
  assert.ok(options.some(isUnknownOrBroadUSOption), 'the placeholder option must still read as unknown/broad US');
  assert.ok(options.some(acceptableLocationOption), 'the composed value must still pass the local triage gate');
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
  // Placeholder with a readable, clean-shaped segment: composes both.
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/Dallas-TX/Engineer'),
    'Dallas, TX; 2 Locations',
  );
  // Placeholder with an unreadable segment: fails closed to null so the
  // caller keeps its existing placeholder text.
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/111-East-210th-Street/Job'),
    null,
  );
  // Placeholder with a segment that parses but has no state (bare city, or
  // label-stripped): also fails closed rather than composing a primary that
  // isn't actually a confident single place.
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/Plainville/Job'),
    null,
  );
  assert.equal(
    resolveWorkdayPlaceholderLocation('2 Locations', '/job/Phoenix-Office/Job'),
    null,
  );
});
