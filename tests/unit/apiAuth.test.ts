import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeDashboardRequest } from '../../src/lib/apiAuth';

function request(authorization: string | null, method = 'GET', origin?: string) {
  const headers = new Headers();
  if (authorization) headers.set('authorization', authorization);
  if (origin) headers.set('origin', origin);
  return { headers, method, url: 'https://dashboard.example/api/jobs' };
}

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

test('accepts browser Basic auth and cron Bearer auth', () => {
  const env: NodeJS.ProcessEnv = { DASHBOARD_USERNAME: 'joseph', DASHBOARD_PASSWORD: 'browser-secret', PIPELINE_SECRET: 'cron-secret', NODE_ENV: 'production' };
  assert.equal(authorizeDashboardRequest(request(basic('joseph', 'browser-secret')), env).ok, true);
  assert.equal(authorizeDashboardRequest(request('Bearer cron-secret'), env).ok, true);
});

test('fails closed without configured credentials', () => {
  const result = authorizeDashboardRequest(request(null), { NODE_ENV: 'production' });
  assert.deepEqual(result, { ok: false, reason: 'missing-configuration' });
});

test('development opt-out is explicit and ignored in production', () => {
  assert.equal(authorizeDashboardRequest(request(null), { NODE_ENV: 'development', DASHBOARD_AUTH_DISABLED: 'true' }).ok, true);
  assert.equal(authorizeDashboardRequest(request(null), { NODE_ENV: 'production', DASHBOARD_AUTH_DISABLED: 'true' }).ok, false);
});

test('rejects cross-origin Basic-auth mutations', () => {
  const env: NodeJS.ProcessEnv = { DASHBOARD_PASSWORD: 'secret', NODE_ENV: 'production' };
  const result = authorizeDashboardRequest(request(basic('admin', 'secret'), 'POST', 'https://evil.example'), env);
  assert.deepEqual(result, { ok: false, reason: 'cross-origin-mutation' });
  assert.equal(authorizeDashboardRequest(request(basic('admin', 'secret'), 'POST', 'https://dashboard.example'), env).ok, true);
});
