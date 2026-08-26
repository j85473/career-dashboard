import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildControlDatabaseUrl,
  CONTROL_DATABASE_CONNECTION_LIMIT,
  CONTROL_DATABASE_CONNECT_TIMEOUT_SECONDS,
  CONTROL_DATABASE_POOL_TIMEOUT_SECONDS,
} from '../../src/lib/controlDatabaseUrl';

test('the control database URL preserves datasource options and bounds its pool', () => {
  const result = new URL(buildControlDatabaseUrl(
    'postgresql://career:p%40ss@db.example:5432/dashboard?schema=career&sslmode=require&connection_limit=99',
  ));

  assert.equal(result.protocol, 'postgresql:');
  assert.equal(result.username, 'career');
  assert.equal(result.password, 'p%40ss');
  assert.equal(result.hostname, 'db.example');
  assert.equal(result.pathname, '/dashboard');
  assert.equal(result.searchParams.get('schema'), 'career');
  assert.equal(result.searchParams.get('sslmode'), 'require');
  assert.equal(result.searchParams.get('connection_limit'), String(CONTROL_DATABASE_CONNECTION_LIMIT));
  assert.equal(result.searchParams.get('pool_timeout'), String(CONTROL_DATABASE_POOL_TIMEOUT_SECONDS));
  assert.equal(result.searchParams.get('connect_timeout'), String(CONTROL_DATABASE_CONNECT_TIMEOUT_SECONDS));
});

test('the control database URL rejects a non-PostgreSQL datasource', () => {
  assert.throws(
    () => buildControlDatabaseUrl('mysql://user:password@db.example/dashboard'),
    /PostgreSQL protocol/,
  );
});
