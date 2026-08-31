/**
 * Give the high-churn ATS ledger tables their own autovacuum thresholds, and
 * restore the planner statistics the stats collector lost.
 *
 * The server defaults assume a table is vacuumed once a fifth of its rows are
 * dead. On `AtsIngestionItem` that is roughly 26,000 dead rows, and enrichment
 * updates every item at least twice, so the table carries a large dead fraction
 * between passes. Bloat costs sequential scan time and widens the window in
 * which Serializable transactions conflict -- the cost of which rises with each
 * acquisition lane.
 *
 * These are per-table storage parameters and an ANALYZE. Nothing here changes
 * server configuration, takes an exclusive lock, rewrites a table, or touches
 * any row of pipeline data: autovacuum simply runs sooner on the tables that
 * churn hardest.
 *
 * `career_admin` owns these tables, so no superuser grant is required.
 *
 * Dry run by default. Pass --apply to write.
 */
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

/**
 * Vacuum at 2% dead rather than 20%, analyze at 1%.
 *
 * `AtsIngestionBatch` is deliberately absent: at ~20k rows the default scale
 * factor already triggers it often (eleven passes on the day this was written),
 * so it needs no override.
 */
const CHURN_TABLES = [
  'AtsIngestionItem',
  'AtsAcquisitionWorkReceipt',
  'AtsEndpointSweepReceipt',
  'AtsListingObservation',
] as const;

const STORAGE_PARAMETERS = [
  'autovacuum_vacuum_scale_factor = 0.02',
  'autovacuum_analyze_scale_factor = 0.01',
  'autovacuum_vacuum_threshold = 1000',
  'autovacuum_analyze_threshold = 1000',
] as const;

/** Their stats-collector counters read empty, so the baseline is rebuilt. */
const ANALYZE_TABLES = ['Job', 'AtsCompany'] as const;

type Snapshot = {
  relname: string;
  live: bigint;
  dead: bigint;
  reloptions: string[] | null;
  last_analyze: Date | null;
};

async function main() {
  const before = await prisma.$queryRawUnsafe<Snapshot[]>(`
    SELECT t.relname, t.n_live_tup AS live, t.n_dead_tup AS dead, c.reloptions,
           GREATEST(t.last_analyze, t.last_autoanalyze) AS last_analyze
      FROM pg_stat_user_tables t
      JOIN pg_class c ON c.oid = t.relid
     WHERE t.relname = ANY($1::text[])
     ORDER BY t.n_dead_tup DESC
  `, [...CHURN_TABLES, ...ANALYZE_TABLES]);

  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      wouldSetStorageParameters: CHURN_TABLES,
      storageParameters: STORAGE_PARAMETERS,
      wouldAnalyze: ANALYZE_TABLES,
      current: before.map((row) => ({
        table: row.relname,
        live: Number(row.live),
        dead: Number(row.dead),
        deadPct: Number(row.live) > 0
          ? Number((100 * Number(row.dead) / Number(row.live)).toFixed(1))
          : null,
        reloptions: row.reloptions,
        lastAnalyze: row.last_analyze,
      })),
    }, null, 2));
    return;
  }

  const applied: string[] = [];
  for (const table of CHURN_TABLES) {
    // Identifiers are compile-time constants from CHURN_TABLES, never input.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table}" SET (${STORAGE_PARAMETERS.join(', ')})`,
    );
    applied.push(table);
  }
  const analyzed: string[] = [];
  for (const table of ANALYZE_TABLES) {
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
    analyzed.push(table);
  }

  const after = await prisma.$queryRawUnsafe<Array<{ relname: string; reloptions: string[] | null }>>(`
    SELECT c.relname, c.reloptions FROM pg_class c
     WHERE c.relname = ANY($1::text[])
  `, [...CHURN_TABLES]);

  console.log(JSON.stringify({
    apply: true,
    storageParametersSet: applied,
    analyzed,
    reloptions: after.map((row) => ({ table: row.relname, reloptions: row.reloptions })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
