import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { passesPreFilter } from '../jobFiltering';

const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');

const titleOnly = (title: string) => passesPreFilter({
  title, company: 'Acme Corp', location: '', description: '', url: '',
});

test('the free title gate decides Workday detail spend without a description', () => {
  // Every rejection below is reached on the title alone, so fetching the body
  // first could not have changed the outcome — the request was pure waste.
  for (const title of [
    'Registered Nurse, ICU',
    'Warehouse Associate',
    'Administrative Assistant',
    'Talent Acquisition Partner',
  ]) {
    assert.equal(titleOnly(title).passes, false, title);
  }
  // And the roles worth spending a request on still pass with no body at all.
  for (const title of [
    'Strategic Account Manager',
    'Regional Sales Manager',
    'Director of Channel Partnerships',
  ]) {
    assert.equal(titleOnly(title).passes, true, title);
  }
});

test('Workday details are fetched for surviving titles rather than gated on backlog depth', () => {
  const gate = ingestion.slice(
    ingestion.indexOf('const workdayDetailWorthFetching'),
    ingestion.indexOf('// Fallback if the fetch fails'),
  );
  assert.ok(gate.length > 0, 'the Workday detail gate is missing');
  assert.match(gate, /passesPreFilter\(\{/);
  assert.match(gate, /if \(parentAtsNetworkAllowed && board\.platform === "workday" && job\.externalPath && workdayDetailWorthFetching\)/);
  // The old condition suppressed the fetch whenever the needs_jd backlog was
  // small. Workday stubs are triaged out rather than queued, so that backlog
  // sat at zero and the fetch never resumed.
  assert.doesNotMatch(gate, /!options\.deferWorkdayDescriptions/);
});

test('the gate reads the same raw title fields the ingestion loop later uses', () => {
  // A mismatch here would gate on one title and store another.
  const gate = ingestion.slice(
    ingestion.indexOf('const workdayDetailWorthFetching'),
    ingestion.indexOf('// Fallback if the fetch fails'),
  );
  assert.match(gate, /job\.text \|\| job\.title \|\| job\.name \|\| job\.jobOpeningName/);
  assert.match(ingestion, /const title = job\.text \|\| job\.title \|\| job\.name \|\| job\.jobOpeningName \|\| "Unknown Title"/);
});
