import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeExternalUrl,
  buildPinnedRequestOptions,
  isPublicIpAddress,
  safeExternalFetch,
  type PinnedTarget,
} from '../../src/lib/safeExternalFetch';

test('rejects private, loopback, link-local, and documentation IP ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.1.1', '203.0.113.5', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('rejects unsafe schemes, credentials, ports, internal names, and private DNS answers', async () => {
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const privateLookup = async () => [{ address: '192.168.1.2', family: 4 }];
  await assert.rejects(() => assertSafeExternalUrl('file:///etc/passwd', publicLookup));
  await assert.rejects(() => assertSafeExternalUrl('https://user:pass@example.com', publicLookup));
  await assert.rejects(() => assertSafeExternalUrl('https://example.com:8080', publicLookup));
  await assert.rejects(() => assertSafeExternalUrl('http://service.local', publicLookup));
  await assert.rejects(() => assertSafeExternalUrl('https://example.com', privateLookup));
  assert.equal((await assertSafeExternalUrl('https://example.com/jobs', publicLookup)).hostname, 'example.com');
});

test('pins the connection to the validated IP while preserving Host and TLS servername', () => {
  const target: PinnedTarget = {
    url: new URL('https://jobs.example.com/openings?id=123'),
    address: '8.8.8.8',
    family: 4,
  };
  const options = buildPinnedRequestOptions(target, { headers: { 'x-test': 'yes' } });

  assert.equal(options.hostname, '8.8.8.8');
  assert.equal(options.path, '/openings?id=123');
  assert.equal(options.servername, 'jobs.example.com');
  assert.equal((options.headers as Record<string, string>).host, 'jobs.example.com');
  assert.equal((options.headers as Record<string, string>)['accept-encoding'], 'identity');
});

test('uses only a validated DNS answer and revalidates each redirect hop', async () => {
  const lookups: string[] = [];
  const requests: PinnedTarget[] = [];
  const lookup = async (hostname: string) => {
    lookups.push(hostname);
    return hostname === 'jobs.example.com'
      ? [{ address: '8.8.8.8', family: 4 }]
      : [{ address: '1.1.1.1', family: 4 }];
  };

  const response = await safeExternalFetch(
    'https://jobs.example.com/start',
    {},
    5,
    {
      lookup,
      request: async (target) => {
        requests.push(target);
        if (requests.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://careers.example.org/final' },
          });
        }
        return new Response('ok', { status: 200 });
      },
    },
  );

  assert.equal(await response.text(), 'ok');
  assert.equal(response.url, 'https://careers.example.org/final');
  assert.deepEqual(lookups, ['jobs.example.com', 'careers.example.org']);
  assert.deepEqual(
    requests.map(({ url, address }) => [url.hostname, address]),
    [['jobs.example.com', '8.8.8.8'], ['careers.example.org', '1.1.1.1']],
  );
});

test('blocks a redirect whose DNS answer becomes private before making that request', async () => {
  const requested: string[] = [];
  const lookup = async (hostname: string) => hostname === 'jobs.example.com'
    ? [{ address: '8.8.8.8', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }];

  await assert.rejects(
    () => safeExternalFetch(
      'https://jobs.example.com/start',
      {},
      5,
      {
        lookup,
        request: async (target) => {
          requested.push(target.address);
          return new Response(null, { status: 302, headers: { location: 'http://evil.example/internal' } });
        },
      },
    ),
    /private or reserved/,
  );
  assert.deepEqual(requested, ['8.8.8.8']);
});
