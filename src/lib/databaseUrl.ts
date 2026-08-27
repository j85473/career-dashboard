export const DATA_DATABASE_CONNECTION_LIMIT = 5;
export const DATA_DATABASE_POOL_TIMEOUT_SECONDS = 10;
export const DATA_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;

function postgresqlUrl(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  return url;
}

export function buildRuntimeDatabaseUrl(databaseUrl: string, runtimeHost?: string): string {
  const url = postgresqlUrl(databaseUrl);
  const host = runtimeHost?.trim();
  if (!host) return url.toString();
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) {
    throw new Error('DATABASE_RUNTIME_HOST must be a hostname or IP address without a scheme or path.');
  }
  url.hostname = host;
  return url.toString();
}

/**
 * Bounds every long-lived data-plane process explicitly. Prisma's default is
 * derived from detected CPU count, so each Next/worker process otherwise adds
 * another independently sized pool to the same small PostgreSQL server.
 */
export function buildDataDatabaseUrl(databaseUrl: string, runtimeHost?: string): string {
  const url = new URL(buildRuntimeDatabaseUrl(databaseUrl, runtimeHost));
  url.searchParams.set('connection_limit', String(DATA_DATABASE_CONNECTION_LIMIT));
  url.searchParams.set('pool_timeout', String(DATA_DATABASE_POOL_TIMEOUT_SECONDS));
  url.searchParams.set('connect_timeout', String(DATA_DATABASE_CONNECT_TIMEOUT_SECONDS));
  return url.toString();
}
