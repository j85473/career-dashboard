import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_SCORING_EXCHANGE_BYTES } from '../scoringExchange';
import { MAX_SCORING_RUN_EXCHANGE_BYTES } from '../scoringLimits';
import { assertScoringMutationRequest, readScoringMutationJson } from '../scoringRequestSecurity';

function request(headers: Record<string, string>, body = '{}') {
  return new Request('http://127.0.0.1:3000/api/scoring/import', {
    method: 'POST',
    headers,
    body,
  });
}

test('scoring mutations require exact same-origin JSON requests', async () => {
  const valid = request({
    origin: 'https://dashboard.example.test',
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'dashboard.example.test',
    'x-forwarded-proto': 'https',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json; charset=utf-8',
  }, '{"ok":true}');
  assert.doesNotThrow(() => assertScoringMutationRequest(valid));
  assert.deepEqual(await readScoringMutationJson(valid), { ok: true });

  assert.throws(() => assertScoringMutationRequest(request({ 'content-type': 'application/json' })), /Origin header is required/);
  assert.throws(() => assertScoringMutationRequest(request({ origin: 'https://evil.example', 'content-type': 'application/json' })), /cross-origin/);
  assert.throws(() => assertScoringMutationRequest(request({ origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })), /cross-site/);
  assert.throws(() => assertScoringMutationRequest(request({ origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' })), /Content-Type/);
});

test('scoring mutations reject a declared body larger than 32 MiB before parsing', () => {
  assert.throws(() => assertScoringMutationRequest(request({
    origin: 'http://127.0.0.1:3000',
    'content-type': 'application/json',
    'content-length': String(MAX_SCORING_EXCHANGE_BYTES + 1),
  })), /32 MiB/);
});

test('run imports may opt into the bounded 64 MiB envelope without weakening the default', async () => {
  const valid = request({
    origin: 'http://127.0.0.1:3000',
    'content-type': 'application/json',
    'content-length': String(MAX_SCORING_EXCHANGE_BYTES + 1),
  }, '{"ok":true}');
  assert.deepEqual(await readScoringMutationJson(valid, MAX_SCORING_RUN_EXCHANGE_BYTES), { ok: true });
  assert.throws(() => assertScoringMutationRequest(request({
    origin: 'http://127.0.0.1:3000',
    'content-type': 'application/json',
    'content-length': String(MAX_SCORING_RUN_EXCHANGE_BYTES + 1),
  }), MAX_SCORING_RUN_EXCHANGE_BYTES), /67108864 bytes/);
});
