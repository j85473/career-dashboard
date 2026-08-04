import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

type ProductionReadiness = {
  tablesReady: boolean;
  jobColumnsReady: boolean;
  hardeningMigrationReady: boolean;
  nativeScoringReady: boolean;
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
            to_regclass('"NativeScoringRequest"') IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'Job'
                AND column_name = 'contextBatchId'
            )
            AND (
              SELECT COUNT(*) = 5
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'JobScoreEvent'
                AND column_name IN (
                  'contextHash', 'contextProfileUpdatedAt',
                  'batchId', 'manifestHash', 'resultHash'
                )
            )
            AND (
              SELECT COUNT(*) = 8
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'ContextRuleRevision'
                AND column_name IN (
                  'idempotencyKey', 'schemaVersion', 'batchId',
                  'chunkId', 'inputHash', 'contextHash', 'manifestHash', 'resultHash'
                )
            )
            AND (
              SELECT COUNT(*) = 20
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'NativeScoringRequest'
                AND column_name IN (
                  'id', 'activeKey', 'status', 'phase', 'source', 'progress',
                  'error', 'workerId', 'claimedAt', 'heartbeatAt', 'completedAt',
                  'attempt', 'contextJobs', 'standardJobs',
                  'contextRuns', 'standardRuns',
                  'contextBatchId', 'standardBatchId',
                  'createdAt', 'updatedAt'
                )
            )
            AND EXISTS (
              SELECT 1
              FROM "_prisma_migrations"
              WHERE migration_name = '20260801210000_native_scoring_automation'
                AND finished_at IS NOT NULL
                AND rolled_back_at IS NULL
            )
            AND EXISTS (
              SELECT 1
              FROM "_prisma_migrations"
              WHERE migration_name = '20260804120000_scoring_v65_expand'
                AND finished_at IS NOT NULL
                AND rolled_back_at IS NULL
            )
          ) AS "nativeScoringReady"
      `;

      if (
        !readiness?.tablesReady
        || !readiness.jobColumnsReady
        || !readiness.hardeningMigrationReady
        || !readiness.nativeScoringReady
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
