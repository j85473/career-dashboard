import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_TRIAGE_ENABLED,
  localTriageVerdict,
  locationTriageVerdict,
  titleTriageVerdict,
} from '../localTriage';

test('triage is enabled by default', () => {
  assert.equal(LOCAL_TRIAGE_ENABLED, true);
});

test('an uncapped role passes title triage', () => {
  const verdict = titleTriageVerdict('');
  assert.equal(verdict.pass, true);
  assert.match(verdict.reason, /discovery metadata only/);
});

test('a capped role is withheld, carrying the cap reason', () => {
  const cap = 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.';
  const verdict = titleTriageVerdict(cap);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, cap);
});

test('locations inside the searched geographies pass', () => {
  for (const location of [
    'Minneapolis, MN',
    'St. Paul, Minnesota',
    'Minnesota',
    'Remote',
    'Remote - United States',
    'United States',
  ]) {
    assert.equal(locationTriageVerdict(location).pass, true, location);
  }
});

test('a location the search lanes never asked for is withheld', () => {
  // Glassdoor returns verified city/state metadata, so a Texas or London role
  // is knowable for free — Aim was paying to reach the same conclusion.
  for (const location of ['Austin, TX', 'Dallas, Texas', 'London, United Kingdom', 'Bengaluru, India']) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, false, location);
    assert.match(verdict.reason, /outside the searched geographies/i);
  }
});

test('a missing location is not treated as a bad location', () => {
  // Absent metadata is not evidence; the JD may still place the role correctly.
  for (const location of [null, undefined, '', '   ']) {
    assert.equal(locationTriageVerdict(location).pass, true, String(location));
  }
});

test('title triage is reported ahead of location when both would reject', () => {
  const cap = 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.';
  const verdict = localTriageVerdict({ capRationale: cap, location: 'Austin, TX' });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, cap);
});

test('a good title in a bad place is still withheld', () => {
  const verdict = localTriageVerdict({ capRationale: '', location: 'Austin, TX' });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('a good title in a searched place passes', () => {
  assert.equal(localTriageVerdict({ capRationale: '', location: 'Minneapolis, MN' }).pass, true);
});

test('triage never promotes — it only ever withholds', () => {
  // Every verdict is either "pass through unchanged" or "withhold with a
  // reason"; there is no branch that admits something the heuristic rejected.
  const passing = localTriageVerdict({ capRationale: '', location: 'Minnesota' });
  assert.equal(passing.pass, true);
  assert.match(passing.reason, /discovery metadata only/);
});

test('a multi-site posting survives if any option is in scope', () => {
  // Real listing: rejecting on the presence of any out-of-scope option would
  // have discarded a role that is genuinely available in Minneapolis.
  for (const location of [
    'Austin, TX; Eau Claire, WI; Minneapolis, MN',
    'Chicago, IL; Minnesota',
    'Dallas, Texas; Remote',
  ]) {
    assert.equal(locationTriageVerdict(location).pass, true, location);
  }
});

test('a multi-site posting entirely outside scope is still withheld', () => {
  for (const location of ['Austin, TX; Dallas, TX', 'London, United Kingdom; Dublin, Ireland']) {
    assert.equal(locationTriageVerdict(location).pass, false, location);
  }
});

test('a globally scoped remote role is withheld despite the Remote fragment', () => {
  // "Remote / Anywhere in the World" splits on the slash, and the bare "Remote"
  // half would otherwise carry the whole posting through.
  for (const location of ['Remote / Anywhere in the World', 'Remote - Worldwide', 'Anywhere in the World']) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, false, location);
    assert.match(verdict.reason, /globally scoped/i);
  }
});

test('a global-remote role that also lists Minneapolis is kept', () => {
  assert.equal(locationTriageVerdict('Remote / Anywhere in the World; Minneapolis, MN').pass, true);
});

test('a territory named in the title is caught even when the location says Remote', () => {
  // Real survivor before this rule: location metadata said "Remote".
  for (const title of [
    'Senior Partner Solutions Engineer - APAC',
    'Channel Account Manager, EMEA',
    'Regional Sales Manager - India',
  ]) {
    const verdict = localTriageVerdict({ capRationale: '', title, location: 'Remote' });
    assert.equal(verdict.pass, false, title);
    assert.match(verdict.reason, /non-US territory/i);
  }
});

test('a Minnesota title is never rejected by the territory rule', () => {
  for (const title of ['Channel Manager, Minneapolis', 'Territory Sales Manager - Minnesota']) {
    assert.equal(localTriageVerdict({ capRationale: '', title, location: 'Remote' }).pass, true, title);
  }
});
