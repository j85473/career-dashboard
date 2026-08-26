import { NextResponse } from 'next/server';
import { controlPrisma } from '@/lib/controlPrisma';

type ProductionReadiness = {
  tablesReady: boolean;
  jobColumnsReady: boolean;
  hardeningMigrationReady: boolean;
  manualScoringReady: boolean;
};

export async function GET() {
  try {
    await controlPrisma.$queryRaw`SELECT 1`;

    if (process.env.NODE_ENV === 'production') {
      const [readiness] = await controlPrisma.$queryRaw<ProductionReadiness[]>`
        SELECT
          (
            to_regclass('"AiUsageEvent"') IS NOT NULL
            AND to_regclass('"ContextRuleRevision"') IS NOT NULL
            AND to_regclass('"JobScoreEvent"') IS NOT NULL
            AND to_regclass('"IngestionSourceRun"') IS NOT NULL
          ) AS "tablesReady",
          (
            SELECT COUNT(*) = 2
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'Job'
              AND column_name IN ('deepseekScoreAttempts', 'deepseekScoreError')
          ) AS "jobColumnsReady",
          EXISTS (
            SELECT 1
            FROM "_prisma_migrations"
            WHERE migration_name = '20260715170000_scoring_hardening'
              AND finished_at IS NOT NULL
              AND rolled_back_at IS NULL
          ) AS "hardeningMigrationReady",
          (
            to_regclass('"ScoringBatch"') IS NOT NULL
            AND to_regclass('"ScoringBatchItem"') IS NOT NULL
            AND to_regclass('"JobScoringArtifact"') IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "_prisma_migrations"
              WHERE migration_name = '20260812170000_manual_scoring_exchange_v1'
                AND finished_at IS NOT NULL
                AND rolled_back_at IS NULL
            )
          ) AS "manualScoringReady"
      `;

      if (
        !readiness?.tablesReady
        || !readiness.jobColumnsReady
        || !readiness.hardeningMigrationReady
        || !readiness.manualScoringReady
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
