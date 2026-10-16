import assert from 'node:assert/strict';
import test from 'node:test';
import { companyLogoDomain } from '../companyLogo';
import { companyWebsiteCandidate, corporateWebsiteLogo, recoverCompanyWebsiteLogo } from '../companyWebsiteLogo';

test('Acosta branding is independent of its Oracle posting and empty site favicon', async () => {
  assert.equal(companyLogoDomain({ company: 'Acosta', url: 'https://eczy-dev3.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/32088/' }), 'acosta.com');
  const url = await recoverCompanyWebsiteLogo('Acosta', async () => { throw new Error('recruiting site unavailable'); });
  assert.equal(url, 'https://www.google.com/s2/favicons?domain=acosta.com&sz=128');
});

test('previously blank employers use reviewed corporate websites without requiring live recruiting metadata', async () => {
  for (const [company, domain] of [
    ['Honeywell', 'honeywell.com'], ['FIS', 'fisglobal.com'], ['US Foods', 'usfoods.com'],
    ['DoiT International', 'doit.com'], ['Gartner', 'gartner.com'], ['Revalize', 'revalizesoftware.com'],
    ['One Eighty Collective', 'oneeightyco.com'], ['Singapore Post Ltd', 'singpost.com'],
  ]) {
    const logo = await recoverCompanyWebsiteLogo(company, async () => { throw new Error('blocked'); });
    assert.equal(new URL(logo!).searchParams.get('domain'), domain);
  }
});

test('reviewed non-com and homonym corrections outrank a plausible but wrong com address', async () => {
  const seen: string[] = [];
  const fetchPage = async (url: string) => { seen.push(url); return new Response('<title>Quantum Health</title>'); };
  assert.equal(new URL((await recoverCompanyWebsiteLogo('Quantum Health, Inc.', fetchPage))!).searchParams.get('domain'), 'quantum-health.com');
  assert.equal(new URL((await recoverCompanyWebsiteLogo('Catchafire', fetchPage))!).searchParams.get('domain'), 'catchafire.org');
  assert.equal(new URL((await recoverCompanyWebsiteLogo('LPW Group', fetchPage))!).searchParams.get('domain'), 'lpw-group.com');
  assert.deepEqual(seen, []);
});

test('a company-name candidate cannot produce a logo unless the website corroborates the name', async () => {
  assert.equal(companyWebsiteCandidate('Example Brand, Inc.'), 'https://examplebrand.com/');
  for (const html of ['', '<title>Domain for sale</title>', '<title>Another Business</title>', '<link rel="icon" href="/logo.png">']) {
    assert.equal(await recoverCompanyWebsiteLogo('Example Brand', async () => new Response(html)), null);
  }
  assert.equal(companyWebsiteCandidate('Unknown Company'), null);
  assert.equal(companyWebsiteCandidate('AB'), null);
  assert.equal(corporateWebsiteLogo('<title></title>', 'https://example.com/', 'https://example.com/', ''), null);
});

test('corporate metadata, brand titles, and own-home logo labels establish a website independently of a job page', async () => {
  for (const html of [
    '<title>Example Brand | Welcome</title>',
    '<meta property="og:site_name" content="Example Brand">',
    '<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Example Brand","url":"https://www.examplebrand.com/"}]}</script>',
    '<header><a href="/"><img alt="Example Brand logo" src="/logo.png"></a></header>',
  ]) {
    assert.equal(corporateWebsiteLogo(html, 'https://examplebrand.com/', 'https://www.examplebrand.com/', 'Example Brand'),
      'https://www.google.com/s2/favicons?domain=examplebrand.com&sz=128');
  }
});

test('redirected brands, challenge pages, unrelated organization declarations and customer logos are rejected', () => {
  assert.equal(corporateWebsiteLogo('<title>Example Brand</title>', 'https://examplebrand.com/', 'https://another.com/', 'Example Brand'), null);
  for (const html of [
    '<title>Just a moment... | Example Brand</title>',
    '<script type="application/ld+json">{"@type":"Organization","name":"Example Brand","url":"https://another.com/"}</script>',
    '<header><a href="https://another.com/"><img alt="Example Brand logo" src="/logo.png"></a></header>',
    '<section class="customers"><img alt="Example Brand logo" src="/logo.png"></section>',
  ]) assert.equal(corporateWebsiteLogo(html, 'https://examplebrand.com/', 'https://examplebrand.com/', 'Example Brand'), null);
});

test('corporate lookup failures keep initials rather than using an unverified name-based favicon', async () => {
  assert.equal(await recoverCompanyWebsiteLogo('Example Brand', async () => new Response('', { status: 403 })), null);
  assert.equal(await recoverCompanyWebsiteLogo('Example Brand', async () => { throw new Error('timeout'); }), null);
});
