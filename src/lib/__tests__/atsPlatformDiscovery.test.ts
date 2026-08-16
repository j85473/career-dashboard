import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORMS, subdomainSlug } from '../../scripts/discoverATS';

// Every platform below was verified against a live tenant: one slug, one
// unauthenticated endpoint, all jobs — the same contract as Greenhouse.

test('the newly wired platforms are all present with a slug-addressable API', () => {
  for (const platform of ['breezy', 'teamtailor', 'pinpoint', 'recruitee', 'rippling', 'personio']) {
    const entry = (PLATFORMS as Record<string, { test_api: string; cc_pattern: string }>)[platform];
    assert.ok(entry, `${platform} should be discoverable`);
    assert.match(entry.test_api, /\{slug\}/, `${platform} must be addressable by slug`);
    assert.ok(entry.cc_pattern.length > 0, `${platform} needs a Common Crawl pattern`);
  }
});

test('JazzHR is deliberately absent', () => {
  // Its RSS path answers HTTP 200 with a 404 HTML body even for real tenants
  // (verified on raptive, dtexsystems, ticketmanager), so status-only
  // validation would accept every slug. The real API needs a per-customer key.
  assert.equal('jazzhr' in PLATFORMS, false);
  assert.equal('applytojob' in PLATFORMS, false);
});

test('vendor subdomains are not mistaken for tenants', () => {
  // A sweep of "*.recruitee.com" returns the vendor's own hosts far more often
  // than customers, and each would otherwise be validated as a slug.
  const pattern = /https?:\/\/([^.]+)\.recruitee\.com/;
  for (const host of ['www', 'support', 'docs', 'help', 'blog', 'api', 'careers']) {
    assert.equal(subdomainSlug(`https://${host}.recruitee.com/o/job`, pattern), null, host);
  }
  assert.equal(subdomainSlug('https://nmbrs.recruitee.com/o/consultant', pattern), 'nmbrs');
});

test('each platform extracts the slug from a real posting URL', () => {
  const cases: Array<[string, string, string]> = [
    ['breezy', 'https://fathom.breezy.hr/p/1b0072dc-manager', 'fathom'],
    ['teamtailor', 'https://barbri.teamtailor.com/jobs/8218173-bd-manager', 'barbri'],
    ['pinpoint', 'https://multiplier-careers.pinpointhq.com/en/postings/caa511ae', 'multiplier-careers'],
    ['recruitee', 'https://nmbrs.recruitee.com/o/implementatieconsultant-2', 'nmbrs'],
    // Rippling is path-scoped, not subdomain-scoped.
    ['rippling', 'https://ats.rippling.com/rippling/jobs/2f0674e6-f01f', 'rippling'],
    ['personio', 'https://personio.jobs.personio.de/job/1834171', 'personio'],
  ];
  for (const [platform, url, expected] of cases) {
    const entry = (PLATFORMS as Record<string, { extract_slug: (u: string) => string | null }>)[platform];
    assert.equal(entry.extract_slug(url), expected, platform);
  }
});

test('rippling ignores its own API and asset paths', () => {
  const entry = (PLATFORMS as Record<string, { extract_slug: (u: string) => string | null }>).rippling;
  for (const path of ['api', 'jobs', 'assets', '_next']) {
    assert.equal(entry.extract_slug(`https://ats.rippling.com/${path}/something`), null, path);
  }
});

test('the job accessors match each live response envelope', () => {
  const entries = PLATFORMS as Record<string, { get_jobs: (d: unknown) => unknown[] }>;
  assert.deepEqual(entries.breezy.get_jobs([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(entries.rippling.get_jobs([{ uuid: 'a' }]), [{ uuid: 'a' }]);
  assert.deepEqual(entries.teamtailor.get_jobs({ items: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(entries.pinpoint.get_jobs({ data: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(entries.recruitee.get_jobs({ offers: [{ id: 'a' }] }), [{ id: 'a' }]);
  // An empty or unexpected envelope must yield an empty list, never a throw.
  for (const key of Object.keys(entries)) {
    assert.deepEqual(entries[key].get_jobs({}), [], key);
  }
});
