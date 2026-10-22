import assert from 'node:assert/strict';
import test from 'node:test';
import { latestUserCanonicalJobUrl, userCanonicalJobUrlFields } from '../userCanonicalJobUrl';

test('user links retain their path, query and fragment instead of being cleaned or redirected', () => {
  const url = 'https://example.com/Apply/123?utm_source=joe&source=posting#job';
  const fields = userCanonicalJobUrlFields(` ${url} `);
  assert.equal(fields.url, url);
  assert.equal(fields.canonicalUrl, url);
  assert.equal(fields.userCanonicalUrl, url);
  for (const invalid of ['', 'not a url', 'javascript:alert(1)', 'https://joe:secret@example.com/job']) {
    assert.throws(() => userCanonicalJobUrlFields(invalid), /valid HTTP or HTTPS/);
  }
});

test('source preference never outranks a newer user choice', () => {
  const old = userCanonicalJobUrlFields('https://old.example/jobs/123', new Date('2026-10-21'));
  const latest = userCanonicalJobUrlFields('https://new.example/jobs/456', new Date('2026-10-22'));
  assert.equal(latestUserCanonicalJobUrl([old, latest]), latest);
  assert.equal(latestUserCanonicalJobUrl([latest, old]), latest);
  assert.equal(latestUserCanonicalJobUrl([{}, { userCanonicalUrl: null }]), undefined);
});
