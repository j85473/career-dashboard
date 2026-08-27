import { PrismaClient } from '@prisma/client';
import { buildDataDatabaseUrl } from './databaseUrl';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const sourceUrl = process.env.DATABASE_URL;
const datasourceUrl = sourceUrl
  ? buildDataDatabaseUrl(sourceUrl, process.env.DATABASE_RUNTIME_HOST)
  : undefined;

export const prisma =
  globalForPrisma.prisma || new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
