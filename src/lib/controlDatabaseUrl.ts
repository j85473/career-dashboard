export const CONTROL_DATABASE_CONNECTION_LIMIT = 2;
export const CONTROL_DATABASE_POOL_TIMEOUT_SECONDS = 5;
export const CONTROL_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;

/**
 * Builds the deliberately small connection pool used by pipeline control.
 *
 * Health, status, stop checks, and lock heartbeats must not queue behind the
 * ingestion pool they are meant to supervise. Keep every existing datasource
 * option (schema, SSL, PgBouncer, and so on), replacing only the bounded pool
 * settings owned by this client.
 */
export function buildControlDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }

  url.searchParams.set('connection_limit', String(CONTROL_DATABASE_CONNECTION_LIMIT));
  url.searchParams.set('pool_timeout', String(CONTROL_DATABASE_POOL_TIMEOUT_SECONDS));
  url.searchParams.set('connect_timeout', String(CONTROL_DATABASE_CONNECT_TIMEOUT_SECONDS));
  return url.toString();
}
