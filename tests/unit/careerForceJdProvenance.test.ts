import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { preferredJdSourceUrl } from '../../src/lib/jobSourceProvenance';

const employerUrl = 'https://apply.actalentservices.com/job/123';
const jobsynUrl = 'https://de.jobsyn.org/0123456789abcdef0123456789abcdef8003';

test('CareerForce recovery prefers the original Jobsyn observation over the employer Apply URL', () => {
  assert.equal(preferredJdSourceUrl({
    source: 'careerforce',
    jobUrl: employerUrl,
    observations: [
      { source: 'Other', url: 'https://example.com/job/123' },
      { source: 'CareerForce', url: jobsynUrl },
    ],
  }), jobsynUrl);
});

test('CareerForce recovery falls back to the employer URL when no DEjobs provenance exists', () => {
  assert.equal(preferredJdSourceUrl({
    source: 'careerforce',
    jobUrl: employerUrl,
    observations: [
      { source: 'careerforce', url: 'https://not-jobsyn.example/de.jobsyn.org/fake' },
    ],
  }), employerUrl);
});

test('other sources keep their Job URL even if a DEjobs observation is present', () => {
  assert.equal(preferredJdSourceUrl({
    source: 'ATS-workday',
    jobUrl: employerUrl,
    observations: [{ source: 'careerforce', url: jobsynUrl }],
  }), employerUrl);
});

test('CareerForce ingestion extracts before redirecting and persists source provenance for recovery', () => {
  const scraper = readFileSync('src/scripts/careerForceScraper.ts', 'utf8');
  const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const recovery = readFileSync('src/app/api/jobs/batch-jd-submit/route.ts', 'utf8');
  const manualScrape = readFileSync('src/app/api/jobs/[id]/scrape/route.ts', 'utf8');

  const sourceUrlIndex = scraper.indexOf('const sourceApplyUrl =');
  const sourceExtractionIndex = scraper.indexOf('await scrapeAtsApi(sourceApplyUrl)', sourceUrlIndex);
  const redirectIndex = scraper.indexOf('await resolver.resolve(finalApplyLink)', sourceUrlIndex);
  assert.ok(sourceUrlIndex >= 0, 'CareerForce raw source URL is not captured');
  assert.ok(sourceExtractionIndex > sourceUrlIndex, 'CareerForce source extraction is missing');
  assert.ok(redirectIndex > sourceExtractionIndex, 'CareerForce must extract before following the redirect');
  assert.match(scraper, /sourceUrl: sourceApplyUrl/);

  assert.match(ingestion, /const observationUrl = input\.sourceUrl \? normalizeUrl\(input\.sourceUrl\) : input\.url/);
  assert.match(ingestion, /observations: \{ create: \{ source: input\.source, sourceId, url: observationUrl/);

  assert.match(recovery, /include: \{[\s\S]*?observations: \{[\s\S]*?select: \{ source: true, url: true \}/);
  assert.match(recovery, /const sourceExtractionUrl = preferredJdSourceUrl\(\{/);
  assert.match(recovery, /const atsResult = await scrapeAtsApi\(extractionUrl\)/);
  assert.match(recovery, /buildSafeJinaReaderUrl\(extractionUrl\)/);

  assert.match(manualScrape, /const submittedStoredUrl = \[existingJob\.url, existingJob\.canonicalUrl\]/);
  assert.match(manualScrape, /const extractionUrl = submittedStoredUrl[\s\S]*?preferredJdSourceUrl\(\{/);
  assert.match(manualScrape, /const atsResult = await scrapeAtsApi\(extractionUrl\)/);
  assert.match(manualScrape, /buildSafeJinaReaderUrl\(extractionUrl\)/);
});
