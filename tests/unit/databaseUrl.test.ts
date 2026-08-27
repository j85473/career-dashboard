import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildDataDatabaseUrl,
  buildRuntimeDatabaseUrl,
  DATA_DATABASE_CONNECTION_LIMIT,
  DATA_DATABASE_CONNECT_TIMEOUT_SECONDS,
  DATA_DATABASE_POOL_TIMEOUT_SECONDS,
} from '../../src/lib/databaseUrl';

test('the data-plane URL uses loopback without changing credentials or database identity', () => {
  const result = new URL(buildDataDatabaseUrl(
    'postgresql://career:p%40ss@100.80.154.113:5432/career_db?schema=public&sslmode=prefer',
    '127.0.0.1',
  ));
  assert.equal(result.hostname, '127.0.0.1');
  assert.equal(result.port, '5432');
  assert.equal(result.pathname, '/career_db');
  assert.equal(result.username, 'career');
  assert.equal(result.password, 'p%40ss');
  assert.equal(result.searchParams.get('schema'), 'public');
  assert.equal(result.searchParams.get('sslmode'), 'prefer');
  assert.equal(result.searchParams.get('connection_limit'), String(DATA_DATABASE_CONNECTION_LIMIT));
  assert.equal(result.searchParams.get('pool_timeout'), String(DATA_DATABASE_POOL_TIMEOUT_SECONDS));
  assert.equal(result.searchParams.get('connect_timeout'), String(DATA_DATABASE_CONNECT_TIMEOUT_SECONDS));
});

test('runtime host override is optional and rejects URLs or paths', () => {
  const source = 'postgresql://career:secret@db.example:5432/career_db';
  assert.equal(new URL(buildRuntimeDatabaseUrl(source)).hostname, 'db.example');
  assert.throws(() => buildRuntimeDatabaseUrl(source, 'http://127.0.0.1'), /hostname or IP address/);
  assert.throws(() => buildRuntimeDatabaseUrl(source, '127.0.0.1/database'), /hostname or IP address/);
});

test('all application route handlers share the bounded process-wide Prisma client', () => {
  for (const file of [
    'src/app/api/outreach/route.ts',
    'src/app/api/outreach/import/route.ts',
    'src/app/api/outreach/[id]/route.ts',
    'src/app/api/outreach/[id]/generate/route.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /import \{ prisma \} from '@\/lib\/prisma'/);
    assert.doesNotMatch(source, /new PrismaClient/);
  }
});

test('Pi deployment persists the non-secret runtime database host in the staged environment', () => {
  const source = readFileSync('scripts/deploy.sh', 'utf8');
  assert.match(source, /DATABASE_RUNTIME_HOST="\$\{DATABASE_RUNTIME_HOST:-127\.0\.0\.1\}"/);
  assert.match(source, /grep -Ev '\^DATABASE_RUNTIME_HOST='/);
  assert.match(source, /printf 'DATABASE_RUNTIME_HOST=%s\\n'/);
});
