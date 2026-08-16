import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PLATFORMS } from '../../scripts/discoverATS';

/**
 * A platform the crawler can discover but ingestion cannot fetch is worse than
 * an absent one: boards accumulate in AtsCompany, every run fails with
 * "Unsupported ATS platform", and the boards are eventually blacklisted.
 * Personio was in exactly that state.
 */
const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');

test('every discoverable platform has an ingestion endpoint', () => {
  for (const platform of Object.keys(PLATFORMS)) {
    assert.ok(
      ingestion.includes(`board.platform === "${platform}"`),
      `${platform} is discoverable but ingestion has no branch for it`,
    );
  }
});

test('every discoverable platform has a company and location mapping', () => {
  // Without one, jobs ingest with the raw slug as the company and
  // "Unknown Location", which the location gate cannot evaluate.
  const mappingRegion = ingestion.slice(ingestion.indexOf('// Parse platform specifics'));
  for (const platform of Object.keys(PLATFORMS)) {
    if (platform === 'workday') continue; // keyed by slug::tenant, mapped separately
    assert.ok(
      mappingRegion.includes(`board.platform === "${platform}"`),
      `${platform} has no company/location mapping`,
    );
  }
});

test('the ingestion fallback would surface an unmapped platform loudly', () => {
  // Rather than silently ingesting nothing.
  assert.match(ingestion, /Unsupported ATS platform: \$\{board\.platform\}/);
});

test('personio is fetched as XML, not JSON', () => {
  // It is the only non-JSON board; treating it as JSON threw a "board retired"
  // error on every run.
  assert.match(ingestion, /const expectsXml = board\.platform === 'personio'/);
  assert.match(ingestion, /jobs\.personio\.de\/xml/);
  assert.match(ingestion, /xmlMode: true/);
});
