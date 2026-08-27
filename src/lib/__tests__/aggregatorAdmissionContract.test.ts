import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isRedirectResolutionAggregatorUrl } from '../jobIngestion';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

test('Himalayas listings enter redirect-to-employer ATS resolution', () => {
  assert.equal(isRedirectResolutionAggregatorUrl('https://himalayas.app/companies/acme/jobs/partner-manager'), true);
  assert.equal(isRedirectResolutionAggregatorUrl('https://example.com/jobs/partner-manager'), false);
});

test('new aggregator ingestion adopts unique ATS title and location before identity generation', () => {
  const ingestion = source('src/lib/jobIngestion.ts');
  const matchStart = ingestion.indexOf('if (directMatch) {');
  const identityStart = ingestion.indexOf('identityFingerprint = generateV4Fingerprint', matchStart);
  const matchBlock = ingestion.slice(matchStart, identityStart);
  assert.match(matchBlock, /title = directMatch\.postingTitle/);
  assert.match(matchBlock, /location = directMatch\.postingLocation/);
  assert.ok(matchStart >= 0 && identityStart > matchStart);
});

test('all Inbox writers use the shared company admission policy', () => {
  for (const relativePath of [
    'src/lib/scoringImport.ts',
    'src/app/api/jobs/[id]/route.ts',
    'src/app/api/jobs/[id]/promote/route.ts',
  ]) {
    assert.match(source(relativePath), /resolveInboxAdmission\(/, relativePath);
  }
  assert.match(source('src/app/api/tailoring/import/route.ts'), /parkSameCompanyInboxJobs\(/);
  assert.match(source('src/app/api/pipeline/run/route.ts'), /Startup cooldown enforcement/);
});

test('existing scored-row ATS enrichment still cannot rewrite score identity metadata', () => {
  const directMatch = source('src/lib/atsDirectMatch.ts');
  const start = directMatch.indexOf('export function planDirectMatchEnrichment');
  const end = directMatch.indexOf('export async function applyDirectMatchEnrichment', start);
  const enrichment = directMatch.slice(start, end);
  assert.doesNotMatch(enrichment, /title:/);
  assert.doesNotMatch(enrichment, /company:/);
  assert.doesNotMatch(enrichment, /location:/);
  assert.doesNotMatch(enrichment, /aimFitScore|reqFitScore|staleAt/);
});
