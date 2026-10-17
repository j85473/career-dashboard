import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveExternalDirectAtsPosting } from '../jobIngestion';
import type { DirectAtsMatch } from '../atsDirectMatch';

const posting = {
  title: 'Partner Manager - Remote', company: 'Example', source: 'Dice (Apify)',
  url: 'https://www.dice.com/job-detail/provider-id', location: 'United States',
  description: 'A short source description.',
};
const match: DirectAtsMatch = {
  url: 'https://example.wd1.myworkdayjobs.com/External/job/Remote/Partner-Manager_R123',
  postingTitle: 'Partner Manager', postingLocation: 'Remote Work MN; Minneapolis, MN',
  description: 'A longer employer description with the complete posting and all requirements.',
  platform: 'workday', slug: 'example.wd1::External', matchedVia: 'stored',
};

test('external API intake adopts a verified ATS posting without altering provider evidence', async () => {
  const original = structuredClone(posting);
  const resolved = await resolveExternalDirectAtsPosting(posting, async candidate => {
    assert.deepEqual(candidate, original);
    return match;
  });
  assert.equal(resolved.url, match.url);
  assert.equal(resolved.title, match.postingTitle);
  assert.equal(resolved.location, match.postingLocation);
  assert.equal(resolved.description, match.description);
  assert.equal(resolved.source, posting.source);
  assert.equal(resolved.company, posting.company);
  assert.deepEqual(posting, original);
});

test('an unresolved or ambiguous external posting retains its original metadata', async () => {
  assert.equal(await resolveExternalDirectAtsPosting(posting, async () => null), posting);
});

test('ATS resolution retains a fuller source description and an unstated employer location', async () => {
  const resolved = await resolveExternalDirectAtsPosting(posting, async () => ({
    ...match, description: 'A stub.', postingLocation: null,
  }));
  assert.equal(resolved.description, posting.description);
  assert.equal(resolved.location, posting.location);
  assert.equal(resolved.url, match.url);
});

test('direct ATS and manual imports do not trigger external aggregator matching', async () => {
  for (const candidate of [
    { ...posting, source: 'ATS-workday' },
    { ...posting, source: 'Manual Import' },
    { ...posting, url: match.url },
  ]) {
    assert.equal(await resolveExternalDirectAtsPosting(candidate, async () => {
      assert.fail('already authoritative sources must skip aggregator matching');
    }), candidate);
  }
});

test('external intake resolves before Workday recovery, identity, duplicate detection and card creation', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const start = source.indexOf('export async function ingestExternalJob(');
  const body = source.slice(start, source.indexOf('\nexport ', start + 1));
  const resolution = body.indexOf('await resolveExternalDirectAtsPosting(');
  assert.ok(resolution > body.indexOf("return 'duplicate'"), 'observed cards must return before new-row enrichment');
  assert.ok(resolution < body.indexOf('await recoverExternalWorkdayMetadata({ url, location })'));
  assert.ok(resolution < body.indexOf('generatePostingIdentity('));
  assert.ok(resolution < body.indexOf('generateV4Fingerprint('));
  assert.ok(resolution < body.indexOf('await findLikelyDuplicateJob('));
  const creation = body.slice(body.indexOf('await tx.job.create('));
  assert.match(creation, /\n\s+url,\n\s+canonicalUrl,/);
  assert.match(creation, /observations: \{ create: \{ source: input\.source, sourceId, url: observationUrl/);
});

test('Apify retains its original listing URL when an ATS application link was extracted first', () => {
  const source = readFileSync('src/app/api/pipeline/apify/route.ts', 'utf8');
  const call = source.slice(source.indexOf('const outcome = await ingestExternalJob({'),
    source.indexOf('countExternalIngestionOutcome(counters, outcome)'));
  assert.match(call, /url: canonicalUrl,/);
  assert.match(call, /sourceUrl: url,/);
  const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  assert.match(ingestion, /const observationUrl = input\.sourceUrl \? normalizeUrl\(input\.sourceUrl\) : input\.url/);
});
