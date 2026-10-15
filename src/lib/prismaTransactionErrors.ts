/** Raw SQL retains PostgreSQL's SQLSTATE inside Prisma 7's P2010 envelope. */
export function isPrismaSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (record.code === 'P2034') return true;
  const sqlstate = record.meta?.code ?? record.meta?.driverAdapterError?.cause?.originalCode;
  return record.code === 'P2010'
    && (sqlstate === '40001' || sqlstate === '40P01');
}

/** Database availability and pg-pool checkout failures belong to our storage. */
export function isPrismaConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string' && ['P1000', 'P1001', 'P1002', 'P1017', 'P2024', 'P2037'].includes(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /^(?:timeout exceeded when trying to connect|connection terminated due to connection timeout)$/i.test(message);
}
