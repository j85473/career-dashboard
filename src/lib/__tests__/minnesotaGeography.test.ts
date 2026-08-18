import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAuthoritativeMetadata } from '../authoritativeMetadataGate';

function verdict(location: string | null) {
  return evaluateAuthoritativeMetadata({ title: 'Partner Manager', company: 'Acme', location });
}

/**
 * MINNEAPOLIS_METRO is a hand-maintained list of ~50 municipalities and there
 * are roughly ninety in the metro, so every gap dismissed a Minnesota job as
 * "outside the searched geographies". These are the ones that actually failed.
 */
test('metro suburbs missing from the hardcoded list are still in scope', () => {
  for (const location of [
    'Blaine, MN', 'Apple Valley, MN', 'Anoka, MN', 'Andover, MN', 'Rosemount, MN',
    'Farmington, MN', 'Hastings, MN', 'Elk River, MN', 'Forest Lake, MN', 'Lake Elmo, MN',
    'Lino Lakes, MN', 'Ham Lake, MN', 'Hugo, MN', 'Ramsey, MN', 'St. Anthony, MN',
    'Waconia, Minnesota', 'Victoria, MN',
  ]) {
    assert.equal(verdict(location).passes, true, `${location} was rejected: ${verdict(location).reason}`);
  }
});

test('the names already on the list keep working', () => {
  for (const location of ['Minneapolis, MN', 'St. Paul, MN', 'Saint Paul, MN', 'Bloomington, MN', 'Edina, MN', 'Minnesota', 'MN']) {
    assert.equal(verdict(location).passes, true, `${location} was rejected`);
  }
});

test('outstate Minnesota stays out of scope', () => {
  // In Minnesota, but not commutable — the reason OUTSTATE_MINNESOTA is its own set.
  for (const location of ['Rochester, MN', 'Duluth, MN', 'St. Cloud, MN', 'Mankato, MN', 'Moorhead, MN']) {
    assert.equal(verdict(location).passes, false, `${location} should not pass`);
  }
});

test('the state marker does not leak scope to other states', () => {
  // Guards against a loose "contains MN" rule matching these.
  for (const location of ['Austin, TX', 'London', 'Bengaluru, KA', 'Boston, MA', 'Washington, DC', 'Mnichovo Hradiste, Czechia']) {
    assert.equal(verdict(location).passes, false, `${location} should not pass`);
  }
});

test('a multi-site posting including an unlisted suburb is kept', () => {
  assert.equal(verdict('Austin, TX; London, UK; Blaine, MN').passes, true);
});
