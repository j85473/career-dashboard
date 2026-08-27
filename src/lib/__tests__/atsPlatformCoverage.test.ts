import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PLATFORMS } from '../../scripts/discoverATS';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../atsAcquisition';

/**
 * A platform the crawler can discover but ingestion cannot fetch is worse than
 * an absent one: boards accumulate in AtsCompany, every run fails with
 * "Unsupported ATS platform", and the boards are eventually blacklisted.
 * Personio was in exactly that state.
 */
const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');

test('every discoverable platform has an active split-path acquisition endpoint', () => {
  for (const platform of Object.keys(PLATFORMS)) {
    const slug = platform === 'workday' ? 'example.wd5::Careers' : 'example';
    const request = buildAtsBoardRequest({ slug, platform });
    const url = new URL(request.url);
    assert.equal(url.protocol, 'https:', `${platform} acquisition endpoint must use HTTPS`);
    assert.ok(url.hostname, `${platform} acquisition endpoint must have a hostname`);
  }
});

test('every discoverable platform maps its listing response into the durable job envelope', () => {
  const job = { id: 'job-1', title: 'Channel Manager' };
  const fixtures: Record<string, unknown> = {
    greenhouse: { jobs: [job] },
    lever: [job],
    ashby: { jobs: [job] },
    workday: { total: 1, jobPostings: [job] },
    smartrecruiters: { totalFound: 1, content: [job] },
    workable: { jobs: [job] },
    bamboohr: { result: [job] },
    breezy: [job],
    teamtailor: { items: [job] },
    pinpoint: { data: [job] },
    recruitee: { offers: [job] },
    rippling: [job],
  };

  for (const platform of Object.keys(PLATFORMS)) {
    const parsed = platform === 'personio'
      ? parseAtsListingPayload(platform, {}, '<workzag-jobs><position><id>job-1</id><name>Channel Manager</name></position></workzag-jobs>')
      : parseAtsListingPayload(platform, fixtures[platform]);
    assert.equal(parsed.jobs.length, 1, `${platform} listing parser dropped the job envelope`);
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
