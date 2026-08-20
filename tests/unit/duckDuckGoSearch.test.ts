import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractDuckDuckGoResultUrls,
  searchDuckDuckGo,
} from '../../src/lib/duckDuckGoSearch';

test('extractDuckDuckGoResultUrls decodes redirect targets and ignores unsafe or malformed links', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjobs.example.com%2Frole%3Fa%3D1&amp;rut=abc">Role</a>
    <a class="result__a" href="https://careers.example.org/opening">Opening</a>
    <a class="result__a" href="javascript:alert(1)">Unsafe</a>
    <a class="result__a" href="//duckduckgo.com/l/?rut=missing-target">Missing</a>
    <a class="result__a" href="https://careers.example.org/opening">Duplicate</a>
  `;

  assert.deepEqual(extractDuckDuckGoResultUrls(html), [
    'https://jobs.example.com/role?a=1',
    'https://careers.example.org/opening',
  ]);
});

test('searchDuckDuckGo uses the HTML endpoint and returns parsed result URLs', async () => {
  let requestedUrl: URL | undefined;
  let requestedInit: RequestInit | undefined;
  const urls = await searchDuckDuckGo('Acme account executive careers', async (input, init) => {
    requestedUrl = new URL(input);
    requestedInit = init;
    return new Response(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjobs.acme.test%2F123">Job</a>',
      { status: 200 },
    );
  });

  assert.equal(requestedUrl?.origin, 'https://html.duckduckgo.com');
  assert.equal(requestedUrl?.searchParams.get('q'), 'Acme account executive careers');
  assert.match(new Headers(requestedInit?.headers).get('user-agent') || '', /Mozilla/);
  assert.deepEqual(urls, ['https://jobs.acme.test/123']);
});

test('searchDuckDuckGo fails clearly on a non-success response', async () => {
  await assert.rejects(
    searchDuckDuckGo('Acme careers', async () => new Response('blocked', { status: 403 })),
    /HTTP 403/,
  );
});
