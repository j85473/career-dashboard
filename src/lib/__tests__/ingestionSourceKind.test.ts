import assert from 'node:assert/strict';
import test from 'node:test';

import { isEnrichmentSubSource } from '../ingestionSourceKind';

test('recognises the per-posting detail fetchers', () => {
  // Derived in jobIngestion as `${boardSource} Details`.
  assert.equal(isEnrichmentSubSource('ATS-workday Details'), true);
  assert.equal(isEnrichmentSubSource('Indeed Details'), true);
  assert.equal(isEnrichmentSubSource('Glassdoor (RapidAPI) details'), true);
  assert.equal(isEnrichmentSubSource('  ATS-workday Details  '), true);
});

test('does not swallow real job sources', () => {
  assert.equal(isEnrichmentSubSource('ATS-workday'), false);
  assert.equal(isEnrichmentSubSource('Indeed'), false);
  assert.equal(isEnrichmentSubSource('LinkedIn (Apify)'), false);
  assert.equal(isEnrichmentSubSource('TheMuse'), false);
  // A source that merely mentions details mid-name is still a job source.
  assert.equal(isEnrichmentSubSource('Details Aggregator Feed'), false);
  assert.equal(isEnrichmentSubSource('SomeDetails'), false);
});
