import assert from 'node:assert/strict';
import test from 'node:test';
import { identifyAts } from '../../src/lib/atsUtils';
import { resolveRedirectUrl } from '../../src/lib/atsRedirect';
import { cleanHtmlText } from '../../src/lib/jobIngestion';
import { buildSafeJinaReaderUrl } from '../../src/lib/safeExternalFetch';
import { hostnameMatches, parseHttpUrl, urlMatchesAnyHost } from '../../src/lib/urlHost';

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function responseAt(url: string, body = '', init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('hostname matching accepts exact hosts and subdomains but rejects deceptive URLs', () => {
  assert.equal(hostnameMatches('boards.greenhouse.io', 'greenhouse.io'), true);
  assert.equal(hostnameMatches('greenhouse.io.evil.example', 'greenhouse.io'), false);
  assert.equal(hostnameMatches('notgreenhouse.io', 'greenhouse.io'), false);
  assert.equal(urlMatchesAnyHost('https://greenhouse.io.evil.example/jobs/1', ['greenhouse.io']), false);
  assert.equal(urlMatchesAnyHost('https://evil.example/jobs?next=https://greenhouse.io', ['greenhouse.io']), false);
  assert.equal(parseHttpUrl('file:///etc/passwd'), null);
});

test('ATS detection uses the parsed hostname and query parameters', () => {
  assert.equal(identifyAts({ url: 'https://boards.greenhouse.io/acme/jobs/123' }), 'Greenhouse');
  assert.equal(identifyAts({ url: 'https://careers.acme.example/jobs/123?gh_jid=456' }), 'Greenhouse');
  assert.equal(identifyAts({ url: 'https://greenhouse.io.evil.example/jobs/123' }), 'Unknown');
  assert.equal(identifyAts({ url: 'https://workday.evil.example/jobs/123' }), 'Unknown');
  assert.equal(identifyAts({ url: 'https://evil.example/?next=https://jobs.lever.co/acme/123' }), 'Unknown');
});

test('HTML cleaning removes script and style elements with unusual end-tag whitespace', () => {
  const cleaned = cleanHtmlText('<style>secret-style</style ><p>Visible role</p><script>alert(1)</script >');
  assert.equal(cleaned.includes('secret-style'), false);
  assert.equal(cleaned.includes('alert(1)'), false);
  assert.match(cleaned, /Visible role/);
});

test('Jina reader URL retains a fixed origin after validating the target', async () => {
  const reader = await buildSafeJinaReaderUrl('https://jobs.example.com/opening?id=123', publicLookup);
  assert.equal(reader.origin, 'https://r.jina.ai');
  assert.equal(reader.pathname, '/https://jobs.example.com/opening%3Fid=123');
});

test('redirect resolution returns the validated final response URL', async () => {
  const requested: string[] = [];
  const fetcher = async (input: string | URL) => {
    requested.push(input.toString());
    return responseAt('https://jobs.example.com/opening/123', 'job');
  };

  const resolved = await resolveRedirectUrl('https://redirect.example/123', 1000, fetcher);
  assert.equal(resolved, 'https://jobs.example.com/opening/123');
  assert.deepEqual(requested, ['https://redirect.example/123']);
});

test('Himalayas Apply links are followed through the same safe fetcher', async () => {
  const requested: string[] = [];
  const fetcher = async (input: string | URL) => {
    const url = input.toString();
    requested.push(url);
    if (requested.length === 1) {
      return responseAt(url, '<a href="/jobs/acme-role/apply">Apply now</a>', { status: 200 });
    }
    return responseAt('https://jobs.acme.example/roles/123', '', { status: 200 });
  };

  const resolved = await resolveRedirectUrl('https://himalayas.app/jobs/acme-role', 1000, fetcher);
  assert.equal(resolved, 'https://jobs.acme.example/roles/123');
  assert.deepEqual(requested, [
    'https://himalayas.app/jobs/acme-role',
    'https://himalayas.app/jobs/acme-role/apply',
  ]);
});
