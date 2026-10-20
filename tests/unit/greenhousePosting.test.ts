import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGreenhousePosting, greenhouseEmbedIdentity, greenhouseEmbeddedJobId, greenhouseHostedPosting, parseGreenhousePosting } from '../../src/lib/greenhousePosting';

const url = 'https://www.gonitro.com/about/careers/8185720?gh_jid=8185720';
const identity = { board: 'nitrosoftwareinc', id: '8185720' };
const script = '<script src="https://boards.greenhouse.io/embed/job_board/js?for=nitrosoftwareinc"></script>';
const html = `<html><body><nav>Products and pricing</nav><div id="grnhse_app"></div>${script}<footer>Cookie settings</footer></body></html>`;
const data = { id: 8185720, title: 'Senior Channel Account Manager (Remote)', company_name: 'Nitro',
  location: { name: 'Remote, USA' }, absolute_url: url,
  content: '&lt;p&gt;About Us:&lt;/p&gt;&lt;p&gt;Nitro provides document workflow software.&lt;/p&gt;&lt;p&gt;Build and develop channel partner relationships.&lt;/p&gt;' };
const endpoint = 'https://boards-api.greenhouse.io/v1/boards/nitrosoftwareinc/jobs/8185720';

test('a directly pasted application frame calls the exact Greenhouse API without reading the application form', async () => {
  const calls: string[] = [];
  const posting = await fetchGreenhousePosting('https://job-boards.greenhouse.io/embed/job_app?for=censys&token=8756673002', async target => {
    calls.push(String(target));
    return Response.json({ id: 8756673002, title: 'Channel Account Manager, Central', company_name: 'Censys',
      location: { name: 'Remote - Central United States (Chicago, Dallas)' }, content: '&lt;p&gt;Activate and enable channel partners.&lt;/p&gt;' });
  });
  assert.deepEqual(calls, ['https://boards-api.greenhouse.io/v1/boards/censys/jobs/8756673002']);
  assert.equal(posting?.title, 'Channel Account Manager, Central');
  assert.equal(posting?.company, 'Censys');
  assert.equal(posting?.location, 'Remote - Central United States (Chicago, Dallas)');
  assert.equal(posting?.text, 'Activate and enable channel partners.');
});

test('Nitro job-board script supplies the published board token instead of a hostname guess', async () => {
  assert.deepEqual(greenhouseEmbedIdentity(html, url), identity);
  const calls: string[] = [];
  const posting = await fetchGreenhousePosting(url, async target => {
    calls.push(String(target));
    assert.ok([url, endpoint].includes(String(target)), 'Only the selected posting and declared API board may be read');
    return String(target) === url ? new Response(html) : Response.json(data);
  });
  assert.equal(posting?.company, 'Nitro');
  assert.equal(posting?.title, data.title);
  assert.equal(posting?.location, 'Remote, USA');
  assert.equal(posting?.atsSlug, 'nitrosoftwareinc');
  assert.equal(posting?.platform, 'greenhouse');
  assert.match(posting!.text, /Build and develop channel partner relationships/);
  assert.doesNotMatch(posting!.text, /&lt;|<p>|Products and pricing|Cookie settings/);
  assert.deepEqual(calls, [url, endpoint]);
});

test('both hosted board generations and existing application iframe embeds retain exact identities', async () => {
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.eu.greenhouse.io']) {
    assert.deepEqual(greenhouseHostedPosting(`https://${host}/nitrosoftwareinc/jobs/8185720?source=tracking`), identity);
  }
  const frame = '<iframe src="//boards.greenhouse.io/embed/job_app?token=8185720&amp;for=nitrosoftwareinc"></iframe>';
  assert.deepEqual(greenhouseEmbedIdentity(frame, url), identity);
  assert.equal(greenhouseEmbedIdentity(frame.replace('token=8185720', 'token=9999999'), url), null);
  const posting = await fetchGreenhousePosting('https://job-boards.greenhouse.io/nitrosoftwareinc/jobs/8185720', async target => {
    assert.equal(String(target), endpoint); return Response.json(data);
  });
  assert.equal(posting?.title, data.title);
});

test('embedded Greenhouse extraction rejects ambiguous boards, job numbers and unrelated markup', () => {
  for (const source of [
    '', '<!--'+script+'-->', '<script>const example = "https://boards.greenhouse.io/embed/job_board/js?for=nitrosoftwareinc";</script>',
    script.replace('boards.greenhouse.io', 'boards.greenhouse.io.evil.example'),
    script.replace('https:', 'http:'), script.replace('nitrosoftwareinc', '../other'),
    script + script.replace('nitrosoftwareinc', 'other'), script.replace('?for=', '?for=other&for='),
  ]) assert.equal(greenhouseEmbedIdentity(source, url), null);
  assert.deepEqual(greenhouseEmbedIdentity(script + script, url), identity);
  assert.equal(greenhouseEmbeddedJobId(`${url}&gh_jid=9999999`), null);
  assert.equal(greenhouseEmbeddedJobId(url.replace('gh_jid=8185720', 'gh_jid=bad')), null);
  assert.equal(greenhouseHostedPosting('https://boards.greenhouse.io.evil.example/nitrosoftwareinc/jobs/8185720'), null);
});

test('Greenhouse detail must return the selected posting and preserves authored title wording', () => {
  assert.equal(parseGreenhousePosting({ ...data, id: 9999999 }, identity), null);
  assert.equal(parseGreenhousePosting({ ...data, content: null }, identity), null);
  assert.equal(parseGreenhousePosting({ ...data, title: 'Account Manager at Large' }, identity)?.title, 'Account Manager at Large');
  assert.equal(parseGreenhousePosting({ ...data, company_name: undefined }, identity)?.company, undefined);
  assert.equal(parseGreenhousePosting({ ...data, company_name: undefined }, identity, { name: 'Nitro' })?.company, 'Nitro');
});

test('missing board evidence never triggers speculative API requests', async () => {
  let calls = 0;
  assert.equal(await fetchGreenhousePosting(url, async () => { calls++; return new Response('<title>Nitro jobs</title>'); }), null);
  assert.equal(calls, 1);
});

test('failed optional board branding retains the exact job while redirects cannot change the posting or tenant', async () => {
  const boardUrl = 'https://boards-api.greenhouse.io/v1/boards/nitrosoftwareinc';
  for (const failure of ['page-redirect', 'api-redirect', 'wrong-job', 'board-outage', 'board-redirect', 'none']) {
    const posting = await fetchGreenhousePosting(url, async target => {
      const path = String(target);
      if (path === boardUrl && failure === 'board-outage') throw new Error('Outage');
      const response = path === url ? new Response(html) : path === boardUrl ? Response.json({ name: 'Nitro' })
        : Response.json({ ...data, company_name: undefined, ...(failure === 'wrong-job' ? { id: 9999999 } : {}) });
      if (failure === 'page-redirect' && path === url) Object.defineProperty(response, 'url', { value: url.replace('gonitro.com', 'other.example') });
      if (failure === 'api-redirect' && path === endpoint) Object.defineProperty(response, 'url', { value: endpoint.replace('nitrosoftwareinc', 'other') });
      if (failure === 'board-redirect' && path === boardUrl) Object.defineProperty(response, 'url', { value: boardUrl.replace('nitrosoftwareinc', 'other') });
      return response;
    });
    if (['page-redirect', 'api-redirect', 'wrong-job'].includes(failure)) assert.equal(posting, null);
    else {
      assert.equal(posting?.title, data.title);
      assert.equal(posting?.location, 'Remote, USA');
      assert.equal(posting?.company, failure === 'none' ? 'Nitro' : undefined);
    }
  }
});
