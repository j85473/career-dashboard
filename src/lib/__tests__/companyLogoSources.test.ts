import assert from 'node:assert/strict';
import test from 'node:test';
import { companyLogoBoardUrl, companyLogoSources, corporateLogoSources, postingCompanyWebsites } from '../companyLogoSources';
import { postingLogo } from '../companyLogoRecovery';

const ld = (org: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', hiringOrganization: org })}</script>`;

test('a declared employer website can have a nonliteral domain or non-com suffix', () => {
  const html = ld({ name: 'Example Brand', sameAs: 'https://example.io/' });
  assert.deepEqual(postingCompanyWebsites(html, 'https://jobs.ashbyhq.com/example/42', 'Example Brand'), ['https://example.io/']);
  assert.deepEqual(postingCompanyWebsites(html, 'https://jobs.ashbyhq.com/example/42', 'Other Employer'), []);
  assert.deepEqual(postingCompanyWebsites(ld({ name: 'Example Brand', sameAs: 'https://www.linkedin.com/company/example' }),
    'https://jobs.ashbyhq.com/example/42', 'Example Brand'), []);
  for (const website of ['https://jobs.smartrecruiters.com/Example', 'https://apply.workable.com/example/', 'https://example.recruitee.com/']) {
    assert.deepEqual(postingCompanyWebsites(ld({ name: 'Example Brand', sameAs: website }),
      'https://jobs.ashbyhq.com/example/42', 'Example Brand'), []);
  }
});

test('posting-published brand links can establish a non-com corporate candidate', () => {
  assert.deepEqual(postingCompanyWebsites('<a href="https://examplebrand.ai/press">Website</a>',
    'https://job-boards.greenhouse.io/examplebrand/jobs/42', 'Example Brand'), ['https://examplebrand.ai/']);
  assert.deepEqual(postingCompanyWebsites('<a href="https://unrelated.com/">Our sponsor</a>',
    'https://job-boards.greenhouse.io/examplebrand/jobs/42', 'Example Brand'), []);
});

test('expired postings recover branding from the exact board home', async () => {
  const seen: string[] = [];
  const subject = { company: 'Example Labs', url: 'https://jobs.ashbyhq.com/example-brand/expired' };
  const iterator = companyLogoSources(subject, async url => {
    seen.push(url);
    return url.endsWith('/expired') ? new Response('', { status: 404 })
      : new Response('<img alt="Example Labs logo" src="https://cdn.example.org/brand.png">');
  });
  const first = await iterator.next();
  assert.equal(first.value, 'https://cdn.example.org/brand.png');
  assert.deepEqual(seen, [subject.url, 'https://jobs.ashbyhq.com/example-brand']);
  await iterator.return(undefined);
});

test('board recovery cannot follow a redirect to another employer on the same shared ATS', async () => {
  const subject = { company: 'Example Brand', url: 'https://job-boards.eu.greenhouse.io/example/jobs/42' };
  const candidates = [];
  for await (const candidate of companyLogoSources(subject, async () => {
    const response = new Response('<img alt="Example Brand logo" src="https://cdn.example.org/wrong.png">');
    Object.defineProperty(response, 'url', { value: 'https://job-boards.eu.greenhouse.io/other' });
    return response;
  })) candidates.push(candidate);
  assert.deepEqual(candidates, []);
  assert.equal(companyLogoBoardUrl('https://www.linkedin.com/jobs/42'), null);
  assert.equal(companyLogoBoardUrl('http://127.0.0.1/jobs/42'), null);
});

test('corporate fallback reads actual published icons after confirming the employer', () => {
  const html = '<title>Example Brand</title><link rel="icon" href="/brand.svg"><link rel="apple-touch-icon" href="https://cdn.example.org/touch.png">';
  const urls = corporateLogoSources(html, 'https://examplebrand.com/', 'https://www.examplebrand.com/', 'Example Brand');
  assert.ok(urls.includes('https://www.examplebrand.com/brand.svg'));
  assert.ok(urls.includes('https://cdn.example.org/touch.png'));
  assert.deepEqual(corporateLogoSources(html.replace('Example Brand', 'Other Business'), 'https://examplebrand.com/',
    'https://examplebrand.com/', 'Example Brand'), []);
  assert.deepEqual(corporateLogoSources(html, 'https://examplebrand.com/', 'https://other.com/', 'Example Brand', true), []);
});

test('malformed or unrelated corporate organization logos cannot outrank the site icon', () => {
  const html = '<title>Example Brand</title><script type="application/ld+json">{"@type":"Organization","name":"Customer","url":"https://examplebrand.com/","logo":"/customer.png"}</script><link rel="icon" href="/brand.png">';
  assert.equal(corporateLogoSources(html, 'https://examplebrand.com/', 'https://examplebrand.com/', 'Example Brand')[0], 'https://examplebrand.com/brand.png');
});

test('Rippling branding must name the employer and match the saved board slug', () => {
  const html = (companyName: string, slug: string) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { apiData: { jobBoard: { companyName, slug, logo: { url: 'https://cdn.example.org/logo.png' } } } } },
  })}</script>`;
  assert.equal(postingLogo(html('Example Labs', 'example-brand'), 'https://ats.rippling.com/example-brand/jobs/42', 'Example Labs'), 'https://cdn.example.org/logo.png');
  assert.equal(postingLogo(html('Other Employer', 'example-brand'), 'https://ats.rippling.com/example-brand/jobs/42', 'Example Labs'), null);
  assert.equal(postingLogo(html('Example Labs', 'other'), 'https://ats.rippling.com/example-brand/jobs/42', 'Example Labs'), null);
});

test('a malformed Workday site logo is repaired only under a confirmed employer and tenant', () => {
  const html = ld({ name: 'SPS Commerce Canada, Ltd.' }) + '<meta property="og:image" content="https://sps/assets/logo">';
  const url = 'https://spscommerce.wd108.myworkdayjobs.com/en-US/sps/job/CA/42';
  assert.equal(postingLogo(html, url, 'SPS Commerce'), 'https://spscommerce.wd108.myworkdayjobs.com/en-US/sps/assets/logo');
  assert.equal(postingLogo(html, url, 'Other Employer'), null);
  assert.equal(postingLogo(html.replace('https://sps/', 'https://another/'), url, 'SPS Commerce'), null);
});

test('a failed reviewed favicon tries native corporate images before potentially blocked recruiting pages', async () => {
  const requests: string[] = [];
  const iterator = companyLogoSources({ company: 'Catchafire', url: 'https://jobs.ashbyhq.com/catchafire/42' }, async url => {
    requests.push(url);
    assert.equal(new URL(url).hostname, 'www.catchafire.org');
    return new Response('<link rel="icon" href="/brand.png">');
  });
  assert.equal(new URL((await iterator.next()).value!).searchParams.get('domain'), 'catchafire.org');
  // A repeated candidate is harmless: the image cache deduplicates URLs.
  let candidate: IteratorResult<string>;
  do { candidate = await iterator.next(); } while (!candidate.done && new URL(candidate.value).hostname === 'www.google.com');
  assert.equal(candidate.value, 'https://www.catchafire.org/brand.png');
  assert.deepEqual(requests, ['https://www.catchafire.org/']);
  await iterator.return(undefined);
});
