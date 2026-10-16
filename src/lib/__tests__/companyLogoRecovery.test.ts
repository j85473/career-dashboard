import assert from 'node:assert/strict';
import test from 'node:test';
import { postingLogo, recoverCompanyLogo, workdayLogoImage } from '../companyLogoRecovery';

const ld = (hiringOrganization: unknown, extra = {}) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', hiringOrganization, ...extra,
})}</script>`;

test('shared ATS branding uses the declared employer logo, never the provider favicon', () => {
  const html = `<link rel="icon" href="https://cdn.ashbyprd.com/favicon.png">${ld({
    name: 'Absorb', sameAs: 'https://www.absorblms.com/',
    logo: { '@type': 'ImageObject', contentUrl: 'https://app.ashbyhq.com/api/images/org-theme-logo/absorb.png' },
  })}`;
  assert.equal(postingLogo(html, 'https://jobs.ashbyhq.com/absorblms/42', 'Absorblms'),
    'https://app.ashbyhq.com/api/images/org-theme-logo/absorb.png');
  assert.equal(postingLogo(html, 'https://jobs.ashbyhq.com/absorblms/42', 'Unrelated'), null);
});

test('named header logos recover Greenhouse and SmartRecruiters branding without inventing a domain', () => {
  const html = '<img alt="Banner" src="/banner.png"><img alt="Boulevard Logo" src="https://cdn.example.org/blvd.png">';
  assert.equal(postingLogo(html, 'https://job-boards.greenhouse.io/boulevard/jobs/42', 'Boulevard'), 'https://cdn.example.org/blvd.png');
  assert.equal(postingLogo(html, 'https://job-boards.greenhouse.io/boulevard/jobs/42', 'Different Employer'), null);
});

test('Workday branding is bound to the employer and exact career site', () => {
  const url = 'https://verily.wd1.myworkdayjobs.com/en-US/verily_careers/job/Remote/42';
  const logo = 'https://verily.wd1.myworkdayjobs.com/en-US/verily_careers/assets/logo';
  const html = `${ld({ name: '1170 Verily Health Inc', sameAs: '' })}<meta property="og:image" content="${logo}">`;
  assert.equal(postingLogo(html, url, 'Verily'), logo);
  assert.equal(postingLogo(html.replace('/verily_careers/assets/', '/other_site/assets/'), url, 'Verily'), null);
  assert.equal(postingLogo(html, url, 'Different Employer'), null);
  assert.equal(postingLogo(html.replace('1170 Verily Health Inc', 'Unrelated'), url, 'Verily'), null);
});

test('Oracle favicon requires both employer branding and the matching site number', () => {
  const url = 'https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/42';
  const path = '/hcmRestApi/CandidateExperience/siteFavicon/favicon-152x152.png?siteNumber=CX_1';
  const html = `<meta property="og:site_name" content="Jobs at Acosta"><link rel="icon" href="${path}">`;
  assert.equal(postingLogo(html, url, 'Acosta'), new URL(path, url).href);
  assert.equal(postingLogo(html.replace('siteNumber=CX_1', 'siteNumber=CX_2'), url, 'Acosta'), null);
  assert.equal(postingLogo(html.replace('Jobs at Acosta', 'Oracle'), url, 'Acosta'), null);
});

test('published acronym branding also requires its matching corporate domain', () => {
  const url = 'https://careers.hpe.com/us/en/job/42';
  const org = { name: 'HPE', sameAs: 'https://careers.hpe.com/us/en', logo: 'https://cdn.example.org/hpe.png' };
  assert.equal(postingLogo(ld(org), url, 'Hewlett Packard Enterprise'), org.logo);
  assert.equal(postingLogo(ld({ ...org, sameAs: 'https://unrelated.com/' }), url, 'Hewlett Packard Enterprise'), null);
});

test('generic portal header logos require the named employer and same board home link', () => {
  const html = '<title>Account Manager - PulpoAR | Career Page</title><a class="navbar-brand" href="/pulpoar-career"><img src="https://cdn.example.org/pulpo.png"></a>';
  const url = 'https://www.careers-page.com/pulpoar-career/job/42';
  assert.equal(postingLogo(html, url, 'PulpoAR'), 'https://cdn.example.org/pulpo.png');
  assert.equal(postingLogo(html.replace('href="/pulpoar-career"', 'href="/another-board"'), url, 'PulpoAR'), null);
  assert.equal(postingLogo(html, url, 'Different Employer'), null);
  const jazz = '<title>CSM - Axiom Cloud - Career Page</title><a href="/apply"><img alt="brand logo" src="//cdn.example.org/axiom.png"></a>';
  assert.equal(postingLogo(jazz, 'https://axiomcloud.applytojob.com/apply/42', 'Axiom Cloud'), 'https://cdn.example.org/axiom.png');
});

test('ambiguous logos, malformed data, provider icons, social images and unsafe URLs have no authority', () => {
  for (const html of [
    '<script type="application/ld+json">{broken</script>',
    '<link rel="icon" href="/ats.png"><meta property="og:image" content="/social.png">',
    '<img alt="Acme Logo" src="http://127.0.0.1/logo.png">',
    '<img alt="Acme Logo" src="javascript:alert(1)">',
    '<img alt="Acme Logo" src="/one.png"><img alt="Acme Logo" src="/two.png">',
    ld({ name: 'Other Company', logo: '/other.png' }),
  ]) assert.equal(postingLogo(html, 'https://jobs.example.org/42', 'Acme'), null, html);
});

test('JSON-LD graphs and corporate-domain fallback handle non-com employers', () => {
  const job = { '@type': 'JobPosting', hiringOrganization: { name: 'Acme', sameAs: 'https://www.acme.org/' } };
  const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [job] })}</script>`;
  assert.equal(postingLogo(html, 'https://jobs.ashbyhq.com/acme/42', 'Acme'), 'https://www.google.com/s2/favicons?domain=acme.org&sz=128');
});

test('canonical posting evidence is tried first and reviewed corrections do not fetch', async () => {
  let calls = 0;
  assert.match((await recoverCompanyLogo({ company: 'Catchafire' }, async () => { calls++; throw new Error(); }))!, /domain=catchafire.org/);
  assert.equal(calls, 0);
  const subject = Object.freeze({ company: 'Acme', canonicalUrl: 'https://jobs.ashbyhq.com/acme/42', url: 'https://aggregator.example.org/42' });
  const before = JSON.stringify(subject);
  const seen: string[] = [];
  const result = await recoverCompanyLogo(subject, async url => {
    seen.push(url); return new Response(ld({ name: 'Acme', logo: 'https://cdn.example.org/acme.png' }));
  });
  assert.equal(result, 'https://cdn.example.org/acme.png');
  assert.deepEqual(seen, [subject.canonicalUrl]);
  assert.equal(JSON.stringify(subject), before);
});

test('redirects to another ATS board and unavailable pages keep initials', async () => {
  const subject = { company: 'Acme', url: 'https://jobs.ashbyhq.com/acme/42' };
  assert.equal(await recoverCompanyLogo(subject, async () => {
    const response = new Response(ld({ name: 'Acme', logo: 'https://cdn.example.org/wrong.png' }));
    Object.defineProperty(response, 'url', { value: 'https://jobs.ashbyhq.com/other/42' });
    return response;
  }), null);
  assert.equal(await recoverCompanyLogo(subject, async () => new Response('', { status: 403 })), null);
  assert.equal(await recoverCompanyLogo(subject, async () => { throw new Error('timeout'); }), null);
});

test('Workday image responses use byte signatures and reject empty or HTML assets', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = await workdayLogoImage('https://example.wd1.myworkdayjobs.com/test/assets/logo', async () =>
    new Response(bytes, { headers: { 'Content-Type': 'text/plain' } }));
  assert.equal(image?.type, 'image/png');
  assert.deepEqual(image?.bytes, bytes);
  for (const [site, body] of [['empty', ''], ['html', '<html>Sign in</html>']]) {
    assert.equal(await workdayLogoImage(`https://example.wd1.myworkdayjobs.com/${site}/assets/logo`, async () => new Response(body)), null);
  }
  let fetched = false;
  assert.equal(await workdayLogoImage('https://unrelated.com/assets/logo', async () => { fetched = true; return new Response(bytes); }), null);
  assert.equal(fetched, false);
});
