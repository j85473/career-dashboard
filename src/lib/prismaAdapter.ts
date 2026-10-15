import { PrismaPg } from '@prisma/adapter-pg';
import pg, { type ClientConfig, type PoolConfig } from 'pg';
import { assertPrismaRehearsalUrl } from './prismaRehearsal';
import {
  buildRuntimeDatabaseUrl,
  DATA_DATABASE_CONNECTION_LIMIT,
  DATA_DATABASE_CONNECT_TIMEOUT_SECONDS,
  DATA_DATABASE_POOL_TIMEOUT_SECONDS,
} from './databaseUrl';

function integerOption(url: URL, name: string, fallback: number, minimum: number): number {
  const text = url.searchParams.get(name);
  if (text === null) return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid PostgreSQL ${name} setting.`);
  }
  return value;
}

/** Keep the existing pool ceilings and separate queue/connect deadlines. */
export function buildPrismaAdapterConfig(databaseUrl: string, runtimeHost?: string): {
  pool: PoolConfig;
  schema: string;
} {
  const url = new URL(buildRuntimeDatabaseUrl(databaseUrl, runtimeHost));
  const max = integerOption(url, 'connection_limit', DATA_DATABASE_CONNECTION_LIMIT, 1);
  const poolTimeout = integerOption(url, 'pool_timeout', DATA_DATABASE_POOL_TIMEOUT_SECONDS, 0);
  const connectTimeout = integerOption(url, 'connect_timeout', DATA_DATABASE_CONNECT_TIMEOUT_SECONDS, 0);
  const schema = url.searchParams.get('schema') ?? 'public';
  for (const option of ['connection_limit', 'pool_timeout', 'connect_timeout', 'schema', 'pgbouncer']) {
    url.searchParams.delete(option);
  }

  // pg otherwise uses the pool's queue deadline as the socket-connect deadline.
  // Its supported Client hook preserves our five-second connect bound while
  // data clients can still wait ten seconds for an existing connection.
  class BoundedConnection extends pg.Client {
    constructor(config?: ClientConfig) {
      super({ ...config, connectionTimeoutMillis: connectTimeout * 1000 });
    }
  }

  return {
    pool: {
      connectionString: url.toString(),
      max,
      connectionTimeoutMillis: poolTimeout * 1000,
      idleTimeoutMillis: 10_000,
      Client: BoundedConnection,
    },
    schema,
  };
}

export function createPrismaAdapter(databaseUrl: string, runtimeHost?: string): PrismaPg {
  if (process.env.PRISMA7_REHEARSAL === '1') assertPrismaRehearsalUrl(databaseUrl, runtimeHost);
  const { pool, schema } = buildPrismaAdapterConfig(databaseUrl, runtimeHost);
  return new PrismaPg(pool, { schema });
}
