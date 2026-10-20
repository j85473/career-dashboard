import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { coreAtsPostingPageUrl, greenhousePostingUrl, leverAshbyPostingUrl } from '../../src/lib/coreAtsPostingUrl';
import { fetchLeverAshbyPosting } from '../../src/lib/leverAshbyPosting';
import { scrapeAtsApi } from '../../src/lib/atsApi';
import { boardSlugFromJobUrl } from '../../src/lib/atsBoardYield';

const id = '18e12d92-d9ec-4388-a6cf-3c62d1369681';
const require = createRequire(import.meta.url);

test('pasted Greenhouse application frames resolve exact board, job and posting page', () => {
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.eu.greenhouse.io']) {
    const url = `https://${host}/embed/job_app?for=censys&token=8756673002`;
    assert.deepEqual(greenhousePostingUrl(url), { board: 'censys', id: '8756673002' });
    assert.equal(coreAtsPostingPageUrl(url), `https://${host}/censys/jobs/8756673002`);
    assert.equal(boardSlugFromJobUrl(url, 'greenhouse'), 'censys');
  }
  for (const suffix of ['for=censys', 'for=censys&token=no', 'for=censys&for=other&token=8756673002',
    'for=censys&token=8756673002&token=999', 'for=../other&token=8756673002',
    'for=censys&token=8756673002&gh_jid=999']) {
    const url = `https://job-boards.greenhouse.io/embed/job_app?${suffix}`;
    assert.equal(greenhousePostingUrl(url), null);
    assert.equal(boardSlugFromJobUrl(url, 'greenhouse'), null);
  }
});

test('Lever regions and application aliases retain the selected posting', async () => {
  for (const region of ['', '.eu']) for (const suffix of ['', '/apply', '/apply/?source=board']) {
    const url = `https://jobs${region}.lever.co/acme/${id}${suffix}`;
    const endpoint = `https://api${region}.lever.co/v0/postings/acme/${id}`;
    const result = await fetchLeverAshbyPosting(url, async target => {
      assert.equal(String(target), endpoint);
      return Response.json({ id, text: 'Channel Account Manager', hostedUrl: `https://jobs${region}.lever.co/acme/${id}`,
        descriptionPlain: 'Activate existing partners.', lists: [{ text: 'Requirements', content: '<ul><li>Channel experience</li></ul>' }],
        additionalPlain: 'Company benefits', salaryDescriptionPlain: '$100,000 base salary',
        categories: { location: 'Chicago, IL', allLocations: ['Dallas, TX'] }, workplaceType: 'remote' });
    });
    assert.equal(result?.title, 'Channel Account Manager');
    assert.equal(result?.location, 'Chicago, IL; Dallas, TX (Remote)');
    assert.match(result!.text, /Channel experience/);
    assert.match(result!.text, /\$100,000 base salary/);
    assert.equal(result?.company, undefined, 'Board tokens cannot become employer names');
    assert.equal(coreAtsPostingPageUrl(url).includes('/apply'), false);
  }
});

test('Ashby posting and application aliases select one exact job and retain all locations', async () => {
  for (const suffix of ['', '/application', '/apply', '/application/?utm_source=board']) {
    const url = `https://jobs.ashbyhq.com/acme/${id}${suffix}`;
    const result = await fetchLeverAshbyPosting(url, async target => {
      assert.equal(String(target), 'https://api.ashbyhq.com/posting-api/job-board/acme');
      return Response.json({ jobs: [{ id: 'unrelated', title: 'Wrong role' }, { id, title: 'Account Manager',
        descriptionHtml: '&lt;p&gt;Enable existing channel partners.&lt;/p&gt;', location: 'Chicago, IL',
        secondaryLocations: [{ location: 'Dallas, TX' }], isRemote: true,
        jobUrl: `https://jobs.ashbyhq.com/acme/${id}`, applyUrl: `https://jobs.ashbyhq.com/acme/${id}/application` }] });
    });
    assert.equal(result?.title, 'Account Manager');
    assert.equal(result?.location, 'Chicago, IL; Dallas, TX (Remote)');
    assert.equal(result?.text, 'Enable existing channel partners.');
    assert.equal(result?.company, undefined);
  }
});

test('unselected, malformed and spoofed URLs never make provider API requests', async () => {
  for (const url of ['https://jobs.lever.co/acme', 'https://jobs.ashbyhq.com/acme',
    `https://jobs.lever.co.evil.example/acme/${id}`, `https://app.ashbyhq.com/acme/${id}`,
    `http://jobs.lever.co/acme/${id}`, `https://user@jobs.lever.co/acme/${id}`,
    `https://jobs.lever.co/acme/${id}/unrelated`, `https://jobs.ashbyhq.com/%ZZ/${id}`,
    `https://jobs.lever.co/acme%2Fother/${id}`]) {
    assert.equal(leverAshbyPostingUrl(url), null, url);
    assert.equal(await fetchLeverAshbyPosting(url, async () => assert.fail('No request permitted')), null);
  }
});

test('provider responses cannot switch posting, tenant, region or API endpoint', async () => {
  const lever = `https://jobs.eu.lever.co/acme/${id}`;
  for (const body of [{ id: 'other', text: 'Wrong role' }, { id, text: 'Role', hostedUrl: `https://jobs.lever.co/acme/${id}` },
    { id, text: 'Role', applyUrl: `https://jobs.eu.lever.co/other/${id}/apply` }]) {
    assert.equal(await fetchLeverAshbyPosting(lever, async () => Response.json(body)), null);
  }
  const ashby = `https://jobs.ashbyhq.com/acme/${id}`;
  const job = { id, title: 'Role', jobUrl: ashby };
  for (const jobs of [[job, job], [{ ...job, jobUrl: ashby.replace('/acme/', '/other/') }], [{ ...job, id: 'other' }]]) {
    assert.equal(await fetchLeverAshbyPosting(ashby, async () => Response.json({ jobs })), null);
  }
  const redirected = Response.json({ jobs: [job] });
  Object.defineProperty(redirected, 'url', { value: 'https://api.ashbyhq.com/posting-api/job-board/other' });
  assert.equal(await fetchLeverAshbyPosting(ashby, async () => redirected), null);
});

test('API dispatch pins public addresses and retains Lever EU and Ashby application identity', async t => {
  const requests: string[] = [];
  t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { hostname: string; servername: string; path: string }, callback: (body: Readable) => void) => {
    assert.equal(options.hostname, '8.8.8.8', 'connect to the validated address, not a second DNS lookup');
    assert.ok(['api.eu.lever.co', 'api.ashbyhq.com'].includes(options.servername));
    requests.push(`https://${options.servername}${options.path}`);
    const body = options.servername === 'api.eu.lever.co' ? { id, text: 'Account Manager', descriptionPlain: 'Role duties' }
      : { jobs: [{ id, title: 'Account Manager', descriptionPlain: 'Role duties' }] };
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      const incoming = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
        { statusCode: 200, headers: {}, rawHeaders: ['Content-Type', 'application/json'] });
      queueMicrotask(() => callback(incoming));
    } });
  });
  assert.equal((await scrapeAtsApi(`https://jobs.eu.lever.co/acme/${id}/apply`))?.ats, 'Lever');
  assert.equal((await scrapeAtsApi(`https://jobs.ashbyhq.com/acme/${id}/application`))?.ats, 'Ashby');
  assert.deepEqual(requests, [`https://api.eu.lever.co/v0/postings/acme/${id}`, 'https://api.ashbyhq.com/posting-api/job-board/acme']);
  for (const url of ['https://job-boards.greenhouse.io/embed/job_app?for=censys', 'https://jobs.lever.co/acme', 'https://jobs.ashbyhq.com/acme']) {
    assert.equal(await scrapeAtsApi(url), null);
  }
  assert.equal(requests.length, 2);
});

test('Lever and Ashby cannot connect to private DNS answers or follow provider redirects', async t => {
  const urls = [`https://jobs.lever.co/acme/${id}`, `https://jobs.eu.lever.co/acme/${id}/apply`, `https://jobs.ashbyhq.com/acme/${id}/application`];
  let address = '127.0.0.1';
  t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address, family: 4 }]);
  let requests = 0;
  t.mock.method(require('node:https'), 'request', (options: { hostname: string }, callback: (body: Readable) => void) => {
    requests++;
    assert.equal(options.hostname, '8.8.8.8');
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      const incoming = Object.assign(Readable.from([]), { statusCode: 302, headers: {}, rawHeaders: ['Location', 'http://169.254.169.254/latest/meta-data/'] });
      queueMicrotask(() => callback(incoming));
    } });
  });
  for (const url of urls) await assert.rejects(fetchLeverAshbyPosting(url), /private or reserved address/);
  assert.equal(requests, 0);
  address = '8.8.8.8';
  for (const url of urls) await assert.rejects(fetchLeverAshbyPosting(url), /Too many redirects/);
  assert.equal(requests, 3, 'exactly one public request per provider; never contact the redirect target');
});
