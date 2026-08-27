import { PrismaClient } from '@prisma/client';
import { buildControlDatabaseUrl } from './controlDatabaseUrl';
import { buildRuntimeDatabaseUrl } from './databaseUrl';

type ControlPrismaGlobal = typeof globalThis & {
  __careerDashboardControlPrisma?: PrismaClient;
};

const controlGlobal = globalThis as ControlPrismaGlobal;
const sourceUrl = process.env.DATABASE_URL;
const runtimeSourceUrl = sourceUrl
  ? buildRuntimeDatabaseUrl(sourceUrl, process.env.DATABASE_RUNTIME_HOST)
  : undefined;

/**
 * A process-wide, bounded control-plane pool. This is intentionally separate
 * from the data-plane Prisma client: a saturated ingestion run must never make
 * Stop, Health, Status, or the pipeline lease unreachable.
 */
export const controlPrisma = controlGlobal.__careerDashboardControlPrisma
  ?? new PrismaClient(runtimeSourceUrl ? { datasourceUrl: buildControlDatabaseUrl(runtimeSourceUrl) } : undefined);

controlGlobal.__careerDashboardControlPrisma = controlPrisma;
