import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Address4, Address6 } = require('ip-address');

test('IP parsing preserves IPv4, IPv6, subnet and zone identifier behavior', () => {
  assert.equal(new Address4('192.0.2.1/24').correctForm(), '192.0.2.1');
  assert.equal(new Address6('2001:0db8::1/64').correctForm(), '2001:db8::1');
  const scoped = new Address6('fe80::1%eth0');
  assert.equal(scoped.correctForm(), 'fe80::1');
  assert.equal(scoped.zone, '%eth0');
  assert.equal(Address6.isValid('::ffff:192.0.2.1'), true);
  assert.equal(Address6.isValid('not-an-address'), false);
});

test('IPv6 parsing rejects long malicious zones without blocking the process', () => {
  // Bound the child so a vulnerable parser fails this test instead of hanging CI.
  const result = spawnSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const { Address6 } = require(process.argv[1]);
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      const candidate = 'fe80::1' + '%'.repeat(1024 * 1024) + terminator;
      assert.equal(Address6.isValid(candidate), false);
      assert.throws(() => new Address6(candidate));
    }
  `, require.resolve('ip-address')], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
