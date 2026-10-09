import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recoverExternalWorkdayMetadata } from '../externalWorkdayMetadata';
import { evaluateAuthoritativeMetadata } from '../authoritativeMetadataGate';
import { workdayDetailLocation } from '../workdayLocation';

const url = 'https://revelyst.wd1.myworkdayjobs.com/en-US/EXTERNAL_REVELYST/job/Remote-Work-CA/Territory-Sales-Manager--Bay-Area---Golf-Technology_R0013608-1';

test('the exact Revelyst posting replaces DEjobs broad remote geography before triage', async () => {
  const original = {
    title: 'Territory Sales Manager, Bay Area - Golf Technology',
    company: 'Revelyst',
    location: 'Virtual, USA',
    url,
  };
  assert.equal(evaluateAuthoritativeMetadata(original).passes, true);
  const detail = await recoverExternalWorkdayMetadata(original, async requestedUrl => {
    assert.equal(requestedUrl, url);
    return { text: 'This position is based in the San Francisco Bay Area.', ats: 'Workday', location: 'Remote Work CA' };
  });
  assert.equal(detail?.location, 'Remote Work CA');
  const verdict = evaluateAuthoritativeMetadata({ ...original, location: detail?.location });
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /Remote Work CA/);
});

test('remote-work state labels reject California but keep Minnesota and additional eligible sites', async () => {
  for (const [primary, additional, passes] of [
    ['Remote Work CA', [], false],
    ['Remote Work OR', [], false],
    ['Remote Work MN', [], true],
    ['Remote Work CA', ['Remote Work MN'], true],
    ['Remote Work CA', ['Minneapolis, MN'], true],
    ['Remote Work CA', ['Remote Work TX'], false],
  ] as const) {
    const detail = await recoverExternalWorkdayMetadata({ url, location: 'Virtual, USA' }, async () => ({
      text: '', ats: 'Workday',
      location: workdayDetailLocation({ location: primary, additionalLocations: additional }) || undefined,
    }));
    assert.equal(evaluateAuthoritativeMetadata({ title: 'Partner Manager', company: 'Acme', location: detail?.location }).passes, passes, detail?.location);
  }
});

test('only exact Workday postings with broad source locations trigger recovery', async () => {
  let calls = 0;
  const readDetail = async () => {
    calls += 1;
    return { text: '', ats: 'Workday', location: 'Remote Work CA' };
  };
  for (const location of ['Virtual, USA', 'Remote', 'United States', 'Unknown Location', '2 Locations']) {
    assert.equal((await recoverExternalWorkdayMetadata({ url, location }, readDetail))?.location, 'Remote Work CA');
  }
  assert.equal(calls, 5);
  for (const posting of [
    { url, location: 'Remote Work MN' },
    { url, location: 'Minneapolis, MN; Remote Work CA' },
    { url: url.replace('revelyst.wd1.myworkdayjobs.com', 'example.com'), location: 'Remote' },
    { url: 'https://revelyst.wd1.myworkdayjobs.com/en-US/EXTERNAL_REVELYST', location: 'Remote' },
  ]) assert.equal(await recoverExternalWorkdayMetadata(posting, readDetail), null);
  assert.equal(calls, 5);
});

test('unavailable Workday details preserve the source evidence without guessing from the URL', async () => {
  assert.equal(await recoverExternalWorkdayMetadata({ url, location: 'Virtual, USA' }, async () => null), null);
  assert.equal(await recoverExternalWorkdayMetadata({ url, location: 'Virtual, USA' }, async () => { throw new Error('timeout'); }), null);
});

test('external ingestion uses recovered geography before identity and triage, after existing-observation return', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const start = source.indexOf('export async function ingestExternalJob(');
  const end = source.indexOf('\nexport ', start + 1);
  const ingestion = source.slice(start, end < 0 ? undefined : end);
  const recovery = ingestion.indexOf('await recoverExternalWorkdayMetadata');
  assert.ok(recovery > ingestion.indexOf("return 'duplicate'"));
  assert.ok(recovery < ingestion.indexOf('generateV4Fingerprint'));
  assert.ok(recovery < ingestion.indexOf('evaluateAuthoritativeMetadata'));
  assert.match(ingestion, /if \(workdayDetail\?\.location\) location = workdayDetail\.location/);
});

test('description recovery retains structured ATS location through the scoring metadata tuple', () => {
  const scoring = readFileSync('src/lib/jobScoring.ts', 'utf8');
  assert.match(scoring, /discoveredLocation: extra\.location/);
  assert.match(scoring, /location: atsResult\.location/);
  assert.match(scoring, /location: resolved\.discoveredLocation \|\| currentJob\.location/);
});
