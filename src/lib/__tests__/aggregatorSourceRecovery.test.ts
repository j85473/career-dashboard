import assert from 'node:assert/strict';
import test from 'node:test';
import { sourcePageEvidence, recoverAggregatorSource } from '../aggregatorSourceRecovery';
import type { safeExternalFetch } from '../safeExternalFetch';

const job = { title: 'Account Manager', company: 'Acme', location: 'Minnesota',
  url: 'https://us.trabajo.org/job-123', source: 'JSearch' };
const target = 'https://careers.hireology.com/acme/123/description';
const html = (options: Record<string, unknown> = {}, rest = '') => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', title: job.title, hiringOrganization: { name: job.company },
  jobLocation: { address: { addressRegion: 'Minnesota', addressCountry: 'US' } }, ...options,
})}</script>${rest}`;
const response = (html: string, url: string, status = 200) => {
  const value = new Response(html, { status }); Object.defineProperty(value, 'url', { value: url }); return value;
};

test('source recovery follows the published signed Apply control and verifies the exact employer posting', async () => {
  const called: string[] = [];
  const fetcher = (async (url: string | URL) => {
    called.push(String(url));
    return String(url) === job.url
      ? response(html({}, '<button data-id="123" data-fuente="feed" data-rt="published">Apply now</button>'), job.url)
      : response(html({ url: target }), target);
  }) as typeof safeExternalFetch;
  const result = await recoverAggregatorSource(job, { fetcher });
  assert.equal(result.outcome, 'matched_source_apply');
  assert.equal(result.match?.url, target);
  assert.equal(new URL(called[1]).searchParams.get('rt'), 'published');
  assert.equal(called.length, 2);
});

test('Trabajo can publish its Apply destination in an empty routing anchor', () => {
  const evidence = sourcePageEvidence(job, html({}, '<a data-apply-direct-link data-job-apply-intent="cpc_final_redirect" data-id="123" data-fuente="feed" data-rt="published"></a>'), job.url);
  assert.equal(evidence?.applyUrls.length, 1);
  assert.equal(new URL(evidence!.applyUrls[0]).searchParams.get('id'), '123');
});

test('source recovery rejects employer, country, title and posting-URL substitutions', async () => {
  for (const change of [
    { hiringOrganization: { name: 'Another employer' } },
    { title: 'Software Engineer' },
    { url: 'https://careers.hireology.com/acme/999/description' },
    { jobLocation: null, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'India' } },
  ]) {
    const result = await recoverAggregatorSource(job, { fetcher: (async (url: string | URL) =>
      String(url) === job.url ? response(html({}, `<a href="${target}">Apply now</a>`), job.url)
        : response(html(change), target)) as typeof safeExternalFetch });
    assert.equal(result.match, undefined);
  }
});

test('a failed rival Apply target cannot manufacture uniqueness', async () => {
  const other = target.replace('/123/', '/456/');
  const result = await recoverAggregatorSource(job, { fetcher: (async (url: string | URL) =>
    String(url) === job.url ? response(html({}, `<a href="${target}">Apply</a><a href="${other}">Apply</a>`), job.url)
      : String(url) === target ? response(html({ url: target }), target) : response('', other, 403)) as typeof safeExternalFetch });
  assert.equal(result.outcome, 'source_apply_unavailable');
  assert.equal(result.match, undefined);
});

test('a public employer page is reported separately from unresolved aggregator links', () => {
  const page = 'https://careers.acme.com/job/minnesota/account-manager/123/';
  assert.equal(sourcePageEvidence(job, html({}, '<script src="https://rmkcdn.successfactors.com/a/main.js"></script>'), page)?.employerPage, true);
  assert.equal(sourcePageEvidence(job, html({}, '<script src="https://rmkcdn.successfactors.com/a/main.js"></script>'), job.url)?.employerPage, false);
  assert.equal(sourcePageEvidence(job, html({ hiringOrganization: { name: 'Other' } }), page), null);
});

test('a missing board can be discovered through an official company profile', async () => {
  const source = { ...job, url: 'https://himalayas.app/companies/acme/jobs/account-manager' };
  let seenWebsite = '';
  const result = await recoverAggregatorSource(source, {
    companyProfile: async () => ({ slug: 'acme', website: 'https://acme.com/', responseText: '' }),
    discover: async input => { seenWebsite = input.website; return [{ board: { platform: 'lever', slug: 'acme' },
      evidenceUrl: 'https://acme.com/careers', matchCount: 1,
      postings: [{ title: job.title, url: 'https://jobs.lever.co/acme/123', location: job.location, description: null }] }]; },
  });
  assert.equal(seenWebsite, 'https://acme.com/');
  assert.equal(result.outcome, 'matched_discovered_board');
  assert.equal(result.discoveries?.length, 1);
});

test('discovery keeps historical requisitions in the ambiguity check', async () => {
  const old = { title: job.title, url: 'https://jobs.ashbyhq.com/acme/old', location: job.location, description: null };
  const result = await recoverAggregatorSource({ ...job, url: 'https://himalayas.app/companies/acme/jobs/account-manager' }, {
    competingPostings: [old],
    companyProfile: async () => ({ slug: 'acme', website: 'https://acme.com/', responseText: '' }),
    discover: async () => [{ board: { platform: 'ashby', slug: 'acme' }, evidenceUrl: 'https://acme.com/careers',
      matchCount: 1, postings: [{ ...old, url: 'https://jobs.ashbyhq.com/acme/new' }] }],
  });
  assert.equal(result.match, undefined);
  assert.equal(result.outcome, 'discovered_match_ambiguous');
});
