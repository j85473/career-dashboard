import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseBoardPostings } from '../../src/lib/atsDirectMatch';
import { locationTriageVerdict } from '../../src/lib/localTriage';
import { recruiteePostingLocation, recruiteePostingIdentity, isRecruiteeWorkModeOnlyLocation } from '../../src/lib/recruiteeLocation';

const url = 'https://eleken.recruitee.com/o/account-manager-6';
const offer = { id: 2782310, title: 'Account Manager', position: 93, careers_url: url,
  location: 'Remote job', remote: true, hybrid: false, on_site: false, city: 'Remote', state_name: 'Kyiv', country: 'Ukraine',
  locations: [{ name: 'Remote', city: 'Remote', state: 'Kyiv', country: 'Ukraine' }] };

test('Recruitee remote labels cannot discard the published country and region', () => {
  assert.equal(recruiteePostingLocation(offer), 'Remote — Kyiv, Ukraine');
  assert.equal(locationTriageVerdict(recruiteePostingLocation(offer)).pass, false);
  assert.equal(recruiteePostingLocation({ ...offer, locations: undefined }), 'Remote — Kyiv, Ukraine');
});

test('every published location survives without guessing associations or worldwide eligibility', () => {
  const job = { location: 'Hybrid job', hybrid: true, locations: [
    { city: 'Toronto', state: 'Ontario', country: 'Canada' }, { city: 'Minneapolis', state: 'Minnesota', country: 'United States' },
    { city: 'Minneapolis', state: 'Minnesota', country: 'United States' },
  ] };
  assert.equal(recruiteePostingLocation(job), 'Hybrid — Toronto, Ontario, Canada; Minneapolis, Minnesota, United States');
  assert.equal(locationTriageVerdict(recruiteePostingLocation(job)).pass, true);
  assert.equal(recruiteePostingLocation({ remote: true, locations: [{ country: 'Ukraine' }, { country: 'Poland' }] }), 'Remote — Ukraine; Poland');
  assert.equal(recruiteePostingLocation({ remote: true }), 'Remote');
  assert.equal(recruiteePostingLocation({ hybrid: true, on_site: true, locations: [{ country: 'Canada' }] }), 'Hybrid / On-site — Canada');
});

test('location fallback retains usable labels and ignores malformed fields and role names', () => {
  assert.equal(recruiteePostingLocation({ location: 'London, UK' }), 'London, UK');
  assert.equal(recruiteePostingLocation({ locations: [{ name: 'Europe' }] }), 'Europe');
  assert.equal(recruiteePostingLocation({ location: 'On-site job', city: 'Boston', state_name: 'Massachusetts', country: 'United States' }), 'On-site — Boston, Massachusetts, United States');
  assert.equal(recruiteePostingLocation({ remote: 'true', city: 100, state_name: {}, locations: ['Ukraine', null], name: 'Account Manager' }), '');
  assert.equal(recruiteePostingLocation({ location: 'Remote job', locations: [{ city: 'N/A', country: 'Unknown Location' }] }), 'Remote');
  assert.equal(recruiteePostingLocation(null), '');
});

test('canonical matching and scheduled ingestion use the shared Recruitee location contract', () => {
  const [parsed] = parseBoardPostings('recruitee', { offers: [offer] }, 'eleken');
  assert.equal(parsed.title, 'Account Manager'); // position is a numeric sort order, not the role title.
  assert.equal(parsed.url, url);
  assert.equal(parsed.location, 'Remote — Kyiv, Ukraine');
  const ingestion = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const mapping = ingestion.slice(ingestion.indexOf('// Parse platform specifics'));
  assert.match(mapping, /board\.platform === "recruitee"[\s\S]*?locationStr = recruiteePostingLocation\(job\)/);
});

test('metadata repair accepts only generic work arrangements and exact secure tenant postings', () => {
  for (const location of ['Remote job', 'Remote', 'Hybrid job', 'On-site job', 'Remote / Hybrid']) assert.equal(isRecruiteeWorkModeOnlyLocation(location), true);
  for (const location of ['', null, 'Remote — Kyiv, Ukraine', 'Remote - United States', 'Ukraine', 'Remote, Worldwide']) assert.equal(isRecruiteeWorkModeOnlyLocation(location), false);
  assert.deepEqual(recruiteePostingIdentity(url + '?source=external'), { tenant: 'eleken', slug: 'account-manager-6', url });
  for (const bad of [url.replace('https:', 'http:'), url.replace('.com/', '.com.evil.example/'), url.replace('https://', 'https://user@'), url.replace('.com/', '.com:8443/'), url + '/c/new', 'https://eleken.recruitee.com/']) assert.equal(recruiteePostingIdentity(bad), null);
});
