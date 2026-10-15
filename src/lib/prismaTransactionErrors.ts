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
