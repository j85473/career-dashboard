import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { passesPreFilter } from '../jobFiltering';

const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');

const titleOnly = (title: string) => passesPreFilter({
  title, company: 'Acme Corp', location: '', description: '', url: '',
});

test('the free title gate decides Teamtailor detail spend without a body', () => {
  // Teamtailor's list item already carries content_html, unlike Workday, so
  // this fetch exists purely to recover location -- it must not be reached
  // for a title the free gate was always going to reject.
  for (const title of [
    'Registered Nurse, ICU',
    'Warehouse Associate',
    'Administrative Assistant',
  ]) {
    assert.equal(titleOnly(title).passes, false, title);
  }
  for (const title of [
    'Strategic Account Manager',
    'Regional Sales Manager',
  ]) {
    assert.equal(titleOnly(title).passes, true, title);
  }
});

test('Teamtailor location is fetched from the posting page JSON-LD, gated on the title prefilter', () => {
  const gate = ingestion.slice(
    ingestion.indexOf('const teamtailorDetailWorthFetching'),
    ingestion.indexOf('/**\n             * Rippling'),
  );
  assert.ok(gate.length > 0, 'the Teamtailor detail gate is missing');
  assert.match(gate, /passesPreFilter\(\{/);
  assert.match(gate, /const teamtailorDetailUrl = typeof job\.url === 'string' \? job\.url : null/);
  assert.match(gate, /if \(parentAtsNetworkAllowed && board\.platform === "teamtailor" && teamtailorDetailUrl && teamtailorDetailWorthFetching\)/);
  assert.match(gate, /safeExternalFetch\(teamtailorDetailUrl/);
  assert.match(gate, /extractJsonLdJobPosting/);
  assert.match(gate, /teamtailorLocation = jsonLdLocationString\(jobPosting\.jobLocation\)/);
});

test('the gate reads the same raw title field the ingestion loop later uses', () => {
  const gate = ingestion.slice(
    ingestion.indexOf('const teamtailorDetailWorthFetching'),
    ingestion.indexOf('/**\n             * Rippling'),
  );
  assert.match(gate, /title: job\.title \|\| ''/);
  assert.match(ingestion, /const title = job\.text \|\| job\.title \|\| job\.name \|\| job\.jobOpeningName \|\| "Unknown Title"/);
});

test('Teamtailor jobs no longer fall back to an unconditional "Unknown Location"', () => {
  const mapping = ingestion.slice(
    ingestion.indexOf('} else if (board.platform === "teamtailor") {', ingestion.indexOf('// Parse platform specifics')),
  );
  const teamtailorBranch = mapping.slice(0, mapping.indexOf('} else if (board.platform === "pinpoint")'));
  assert.match(teamtailorBranch, /locationStr = teamtailorLocation \|\| "Unknown Location"/);
});
