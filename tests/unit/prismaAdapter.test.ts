import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import type pg from 'pg';
import { buildPrismaAdapterConfig } from '../../src/lib/prismaAdapter';
import { assertPrismaRehearsalUrl } from '../../src/lib/prismaRehearsal';
import { buildControlDatabaseUrl } from '../../src/lib/controlDatabaseUrl';

test('data and control adapters retain independent bounded connection pools', () => {
  const source = 'postgresql://career:p%40ss@db.example:5432/career_db?schema=other&sslmode=require';
  const data = buildPrismaAdapterConfig(source, '127.0.0.1');
  const control = buildPrismaAdapterConfig(buildControlDatabaseUrl(source), '127.0.0.1');
  assert.equal(data.pool.max, 5);
  assert.equal(data.pool.connectionTimeoutMillis, 10_000);
  assert.equal(control.pool.max, 2);
  assert.equal(control.pool.connectionTimeoutMillis, 5_000);
  assert.equal(control.schema, 'other');
  const url = new URL(control.pool.connectionString!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.password, 'p%40ss');
  assert.equal(url.pathname, '/career_db');
  assert.equal(url.searchParams.get('sslmode'), 'require');
  for (const key of ['schema', 'connection_limit', 'connect_timeout', 'pool_timeout']) {
    assert.equal(url.searchParams.has(key), false);
  }
});

test('a server that accepts TCP but never speaks PostgreSQL hits the connect deadline', async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const { pool } = buildPrismaAdapterConfig(`postgresql://test:test@127.0.0.1:${address.port}/test?connect_timeout=1&pool_timeout=10`);
  const Client = pool.Client!;
  // pg-pool passes its config into this supported constructor hook.
  const configured = Reflect.construct(Client, [pool]) as pg.Client;
  const started = Date.now();
  try {
    await assert.rejects(configured.connect(), /timeout|terminated/i);
    assert.ok(Date.now() - started < 5_000, 'must not wait for the ten-second pool deadline');
  } finally {
    await configured.end().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('malformed pool settings fail before a database connection is attempted', () => {
  for (const suffix of ['connection_limit=0', 'connection_limit=NaN', 'pool_timeout=-1', 'connect_timeout=1.5']) {
    assert.throws(() => buildPrismaAdapterConfig(`postgresql://test:test@localhost/test?${suffix}`), /Invalid PostgreSQL/);
  }
});

test('rehearsal commands cannot use the production database, role, port, or host', () => {
  const safe = 'postgresql://career_prisma7:test@127.0.0.1:55433/career_prisma7';
  assert.doesNotThrow(() => assertPrismaRehearsalUrl(safe));
  for (const url of [safe.replace('/career_prisma7', '/career_db'), safe.replace(':55433', ':5432'), safe.replace('127.0.0.1', '100.107.116.123'), safe.replace('career_prisma7:test', 'career_admin:test')]) {
    assert.throws(() => assertPrismaRehearsalUrl(url), /isolated/);
  }
  assert.throws(() => assertPrismaRehearsalUrl(safe, '100.107.116.123'), /isolated/);
});
