import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

type ProductionReadiness = {
  tablesReady: boolean;
  jobColumnsReady: boolean;
  hardeningMigrationReady: boolean;
};

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    if (process.env.NODE_ENV === 'production') {
      const [readiness] = await prisma.$queryRaw<ProductionReadiness[]>`
        SELECT
          (
            to_regclass('"AiUsageEvent"') IS NOT NULL
            AND to_regclass('"ContextRuleRevision"') IS NOT NULL
            AND to_regclass('"JobScoreEvent"') IS NOT NULL
            AND to_regclass('"IngestionSourceRun"') IS NOT NULL
          ) AS "tablesReady",
          (
            SELECT COUNT(*) = 3
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'Job'
              AND column_name IN ('luckyBatchId', 'deepseekScoreAttempts', 'deepseekScoreError')
          ) AS "jobColumnsReady",
          EXISTS (
            SELECT 1
            FROM "_prisma_migrations"
            WHERE migration_name = '20260715170000_scoring_hardening'
              AND finished_at IS NOT NULL
              AND rolled_back_at IS NULL
          ) AS "hardeningMigrationReady"
      `;

      if (
        !readiness?.tablesReady
        || !readiness.jobColumnsReady
        || !readiness.hardeningMigrationReady
      ) {
        return NextResponse.json(
          { ok: false, database: true, schema: false, migration: false },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    return NextResponse.json(
      { ok: true, database: true, schema: true, migration: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, database: false, schema: false, migration: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
