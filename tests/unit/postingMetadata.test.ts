import assert from 'node:assert/strict';
import test from 'node:test';

import { extractJsonLdJobPosting, jsonLdPostingMetadata } from '../../src/lib/atsApi';
import { completePostingMetadata, parsePostingReaderMetadata, postingLocations, postingRefreshDescription, postingUrlsMatch } from '../../src/lib/postingMetadata';

const url = 'https://careers.example.com/jobs/12345';

test('a canonical refresh fills company and location even when the provider already returned a complete description', async () => {
  const description = 'A full description from the provider';
  const result = await completePostingMetadata({ text: description, ats: 'Lever', title: 'Account Manager' }, async () => ({
    company: 'Actual Employer', location: 'Austin, TX',
  }));
  assert.equal(result?.text, description);
  assert.equal(result?.company, 'Actual Employer');
  assert.equal(result?.location, 'Austin, TX');
  assert.equal(result?.title, 'Account Manager');
});

test('metadata completion preserves provider evidence and does not request another page when both fields are present', async () => {
  let reads = 0;
  const primary = { text: 'Description', ats: 'Workday', company: 'Actual Employer', location: 'Austin, TX; Dallas, TX' };
  const result = await completePostingMetadata(primary, async () => {
    reads += 1;
    return { company: 'Different Employer', location: 'Canada' };
  });
  assert.equal(reads, 0);
  assert.deepEqual(result, primary);
  const partial = await completePostingMetadata({ ...primary, company: undefined }, async () => ({ company: 'Actual Employer', location: 'Different location' }));
  assert.equal(partial?.location, primary.location);
  assert.equal(partial?.company, 'Actual Employer');
});

test('metadata completion survives a blocked page without discarding the provider description or inventing company data', async () => {
  const primary = { text: 'Description', ats: 'Ashby', location: 'Remote' };
  const result = await completePostingMetadata(primary, async () => { throw new Error('Blocked'); });
  assert.equal(result?.company, undefined);
  assert.deepEqual(result, primary);
});

test('metadata-only JSON-LD remains usable when the full description requires the reader fallback', async () => {
  const posting = extractJsonLdJobPosting(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Account Manager', description: '',
    hiringOrganization: { name: 'Actual Employer' },
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
  })}</script>`)!;
  const result = await completePostingMetadata(null, async () => jsonLdPostingMetadata(posting));
  assert.equal(result?.text, '');
  assert.equal(result?.company, 'Actual Employer');
  assert.equal(result?.location, 'Austin, TX');
});

test('generic posting metadata preserves all locations and remote eligibility', () => {
  assert.equal(jsonLdPostingMetadata({
    jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ name: 'United States' }, { name: 'Canada' }],
  }).location, 'United States; Canada (Remote)');
  assert.equal(jsonLdPostingMetadata({ jobLocationType: 'TELECOMMUTE' }).location, 'Remote');
  assert.equal(jsonLdPostingMetadata({ jobLocation: [
    { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    { address: { addressLocality: 'Dallas', addressRegion: 'TX' } },
  ] }).location, 'Austin, TX; Dallas, TX');
  assert.equal(postingLocations('Austin', ['Austin', 'Dallas'], 'hybrid'), 'Austin; Dallas (Hybrid)');
});

test('the generic reader fallback reads explicit company and location from the exact canonical posting', () => {
  const markdown = `Title: Account Manager\nURL Source: ${url}/?utm_source=board\nMarkdown Content:\n# Account Manager\n**Company:** Actual Employer\n**Location:** Austin, TX (Remote)\n## Job Description\nWe support Other Employer in Canada.\nCompany: Other Employer\nLocation: Canada`;
  assert.deepEqual(parsePostingReaderMetadata(markdown, url), { company: 'Actual Employer', location: 'Austin, TX (Remote)' });
  assert.deepEqual(parsePostingReaderMetadata(markdown, url.replace('12345', '67890')), {});
  assert.deepEqual(parsePostingReaderMetadata(markdown.replace(/^URL Source:.*\n/m, ''), url), {});
});

test('reader metadata accepts label headings and rejects placeholders and mentions in the job body', () => {
  const markdown = `URL Source: ${url}\nMarkdown Content:\n## Employer\n[Actual Employer](https://employer.example.com)\n## Job Location\nMelville, NY (Remote)\n## Responsibilities\nCompany: Other Employer`;
  assert.deepEqual(parsePostingReaderMetadata(markdown, url), { company: 'Actual Employer', location: 'Melville, NY (Remote)' });
  assert.deepEqual(parsePostingReaderMetadata(`URL Source: ${url}\nMarkdown Content:\nCompany: Unknown Company\nLocation: Unknown Location\n## Description\nWork with Resideo in New York.`, url), {});
  assert.deepEqual(parsePostingReaderMetadata(`URL Source: ${url}\nMarkdown Content:\nCompany:\nLocation:\n## Description\nWork with Resideo in New York.`, url), {});
});

test('a blocked or incomplete JD still allows verified company and location to refresh while the saved description stays intact', () => {
  const result = postingRefreshDescription({
    description: 'Loading...', structuredSource: false, existingDescription: 'Previously saved description',
    preserveScores: true, metadata: { company: 'Actual Employer', location: 'Austin, TX' },
  });
  assert.equal(result.description, 'Previously saved description');
  assert.equal(result.verified, false);
  assert.throws(() => postingRefreshDescription({
    description: 'Loading...', structuredSource: false, existingDescription: 'Previously saved description',
    preserveScores: true, metadata: {},
  }), /verifiable job details/);
});

test('structured metadata from a similar job cannot replace the canonical posting metadata', () => {
  const html = `<script type="application/ld+json">${JSON.stringify([
    { '@type': 'JobPosting', url: 'https://careers.example.com/jobs/67890', hiringOrganization: { name: 'Other Employer' } },
    { '@type': 'JobPosting', url, hiringOrganization: { name: 'Actual Employer' } },
  ])}</script>`;
  assert.equal(jsonLdPostingMetadata(extractJsonLdJobPosting(html, url)!).company, 'Actual Employer');
  assert.equal(extractJsonLdJobPosting(html, 'https://careers.example.com/jobs/99999'), null);
});

test('posting metadata matching ignores referral tags and keeps query-string posting IDs distinct', () => {
  assert.equal(postingUrlsMatch(`${url}?gh_src=referral`, url), true);
  assert.equal(postingUrlsMatch(`${url}?lever-source=board&lever-origin=applied`, url), true);
  assert.equal(postingUrlsMatch('https://careers.example.com/job?jobId=12345', 'https://careers.example.com/job?jobId=67890'), false);
});
