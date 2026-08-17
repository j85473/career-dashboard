import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanHtmlText, parseHimalayasJob } from '../jobIngestion';

test('Greenhouse escaped content is stripped, not rendered as visible tags', () => {
  // Verbatim shape from boards-api.greenhouse.io/v1/boards/chainguard/jobs.
  const greenhouse = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Chainguard is the '
    + 'trusted source for open source.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Own partner-sourced '
    + 'pipeline.&lt;/li&gt;&lt;li&gt;Drive co-selling motions.&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;';
  const text = cleanHtmlText(greenhouse);
  assert.equal(/<\/?[a-z]/i.test(text), false, `markup survived: ${text}`);
  assert.match(text, /Chainguard is the trusted source/);
  assert.match(text, /Own partner-sourced pipeline/);
  assert.match(text, /• /);
});

test('ordinary HTML still cleans in one pass', () => {
  const text = cleanHtmlText('<div><p>Role summary.</p><ul><li>Duty one</li></ul></div>');
  assert.equal(text, 'Role summary.\n• Duty one');
});

test('job text that merely contains angle brackets is never truncated', () => {
  // The travel extractor depends on these surviving intact.
  for (const raw of ['<10% travel required', 'Salary <100k considered', 'Up to <25% overnight travel']) {
    assert.equal(cleanHtmlText(raw), raw);
  }
});

test('empty and plain input are unchanged', () => {
  assert.equal(cleanHtmlText(''), '');
  assert.equal(cleanHtmlText('Plain description with no markup.'), 'Plain description with no markup.');
});

test('Himalayas second-precision pubDate no longer dates postings to 1970', () => {
  const parsed = parseHimalayasJob({
    title: 'Senior Partner Manager',
    guid: 'abc123',
    companyName: 'Chainguard',
    description: '<p>Body</p>',
    pubDate: 1786928825, // seconds — 2026-08-17
    applicationLink: 'https://himalayas.app/companies/chainguard/jobs/senior-partner-manager',
  });
  assert.ok(parsed);
  assert.ok(parsed.postedAt instanceof Date);
  assert.equal((parsed.postedAt as Date).getUTCFullYear(), 2026);
});

test('a millisecond pubDate is still read correctly', () => {
  const parsed = parseHimalayasJob({
    title: 'Partner Manager', guid: 'x', companyName: 'Acme',
    pubDate: 1786928825000, applicationLink: 'https://himalayas.app/x',
  });
  assert.ok(parsed);
  assert.ok(parsed.postedAt instanceof Date);
  assert.equal((parsed.postedAt as Date).getUTCFullYear(), 2026);
});
