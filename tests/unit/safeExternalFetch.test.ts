import assert from 'node:assert/strict';
import test from 'node:test';

test('manual redirect exposes one validated hop and forwards a smaller response allowance', async () => {
  const calls: string[] = [];
  const response = await safeExternalFetch('https://public.example/start', { redirect: 'manual' }, 0, {
    maximumBytes: 512 * 1024,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (target, _init, maximumBytes) => {
      calls.push(target.url.href);
      assert.equal(maximumBytes, 512 * 1024);
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
  });
  assert.equal(response.status, 302);
  assert.equal(response.url, 'https://public.example/start');
  assert.deepEqual(calls, ['https://public.example/start']);
});

test('redirect error mode and invalid response allowances stop before another request', async () => {
  let calls = 0;
  const dependencies = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { calls++; return new Response(null, { status: 301, headers: { location: 'https://next.example/' } }); },
  };
  await assert.rejects(() => safeExternalFetch('https://public.example/', { redirect: 'error' }, 5, dependencies), /redirects are not allowed/);
  assert.equal(calls, 1);
  for (const maximumBytes of [0, -1, 1.5, Infinity, NaN, 16 * 1024 * 1024]) {
    await assert.rejects(() => safeExternalFetch('https://public.example/', {}, 5, { ...dependencies, maximumBytes }), /byte limit/);
  }
  assert.equal(calls, 1);
});

test('a crawler can bound address failover to one HTTP attempt', async () => {
  let calls = 0;
  await assert.rejects(() => safeExternalFetch('https://public.example/', {}, 0, {
    maximumAddressAttempts: 1,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }],
    request: async () => { calls++; throw new Error('Simulated transfer failure'); },
  }), /Simulated transfer failure/);
  assert.equal(calls, 1);
});
import { Readable } from 'node:stream';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import {
  assertSafeExternalUrl,
  assertSafeExternalNavigationUrl,
  buildPinnedRequestOptions,
  isPublicIpAddress,
  safeExternalFetch,
  readExternalResponseBody,
  type PinnedTarget,
} from '../../src/lib/safeExternalFetch';

test('browser navigation accepts posting URLs without DNS and rejects unsafe destinations', () => {
  const workdayUrl = 'https://solera.wd5.myworkdayjobs.com/en-US/Global_Career_Site/job/Virtual-US/Channel-Account-Manager_JR-020114';
  assert.equal(assertSafeExternalNavigationUrl(workdayUrl).href, workdayUrl);
  for (const url of [
    'invalid', 'javascript:alert(1)', 'file:///etc/passwd',
    'https://user:pass@example.com', 'https://example.com:8080',
    'http://localhost', 'http://service.local', 'http://service.internal',
    'http://service.lan', 'http://127.0.0.1', 'http://2130706433',
    'http://100.107.116.123', 'http://[::1]',
  ]) {
    assert.throws(() => assertSafeExternalNavigationUrl(url), url);
  }
});

test('server fetch validation still rejects unresolved hostnames', async () => {
  await assert.rejects(
    () => assertSafeExternalUrl('https://solera.wd5.myworkdayjobs.com/jobs', async () => {
      throw new Error('EAI_AGAIN');
    }),
    /hostname could not be resolved/,
  );
});

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
  assert.equal((options.headers as Record<string, string>)['accept-encoding'], 'gzip, deflate, br');
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


for (const [encoding, compress] of [
  ['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync],
] as const) {
  test('pinned transport decodes ' + encoding + ' without changing bytes', async () => {
    const expected = Buffer.from('{"description":"A full, unchanged job description."}');
    const body = await readExternalResponseBody(Readable.from([compress(expected)]), encoding);
    assert.deepEqual(Buffer.from(body), expected);
  });
}
test('stacked encodings decode in reverse application order', async () => {
  const expected = Buffer.from('unchanged payload');
  const body = await readExternalResponseBody(Readable.from([brotliCompressSync(gzipSync(expected))]), 'gzip, br');
  assert.deepEqual(Buffer.from(body), expected);
});
test('both wire size and decompressed size remain bounded', async () => {
  await assert.rejects(readExternalResponseBody(Readable.from([Buffer.alloc(100)]), undefined, 32), /exceeds 32 bytes/);
  const compressed = gzipSync(Buffer.alloc(100_000, 'a'));
  assert.ok(compressed.length < 1024);
  await assert.rejects(readExternalResponseBody(Readable.from([compressed]), 'gzip', 1024), /after decoding/);
});
test('corrupt, truncated and unsupported encodings fail closed', async () => {
  await assert.rejects(readExternalResponseBody(Readable.from([Buffer.from('not gzip')]), 'gzip'));
  const compressed = gzipSync(Buffer.from('complete text'));
  await assert.rejects(readExternalResponseBody(Readable.from([compressed.subarray(0, compressed.length-4)]), 'gzip'));
  await assert.rejects(readExternalResponseBody(Readable.from([compressed]), 'unsupported'), /Unsupported/);
});
test('cancellation destroys the entire decompression pipeline', async () => {
  const source = new Readable({ read() {} });
  const controller = new AbortController();
  const reading = readExternalResponseBody(source, 'gzip', 1024, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(reading, /abort/i);
  assert.equal(source.destroyed, true);
});
