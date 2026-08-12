import fs from 'node:fs';

import { prisma } from '../src/lib/prisma';

type CountRow = Record<string, bigint | number | string | null>;

function numbers(row: CountRow | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
}

async function main(): Promise<void> {
  const [tables] = await prisma.$queryRaw<Array<{ batch: string | null; item: string | null; artifact: string | null }>>`
    SELECT
      to_regclass('public."ScoringBatch"')::text AS batch,
      to_regclass('public."ScoringBatchItem"')::text AS item,
      to_regclass('public."JobScoringArtifact"')::text AS artifact
  `;
  const schemaReady = Boolean(tables?.batch && tables?.item && tables?.artifact);

  const [legacyRows, nativeRows] = await Promise.all([
    prisma.$queryRaw<CountRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "afBatchId" LIKE 'manual_export_%')::bigint AS "legacyManualExportLeases",
        COUNT(*) FILTER (WHERE "afBatchId" LIKE 'native_%')::bigint AS "nativeJobLeases",
        COUNT(*) FILTER (WHERE "afBatchId" IS NOT NULL)::bigint AS "allAfBatchLeases"
      FROM "Job"
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::bigint AS "nonterminalRequests",
        COUNT(*) FILTER (WHERE "activeKey" IS NOT NULL)::bigint AS "activeKeys",
        COUNT(*) FILTER (WHERE status = 'failed' AND "activeKey" IS NOT NULL)::bigint AS "failedActiveKeys"
      FROM "NativeScoringRequest"
    `,
  ]);

  let staged: Record<string, number> = {};
  if (schemaReady) {
    const [row] = await prisma.$queryRaw<CountRow[]>`
      SELECT
        (SELECT COUNT(*) FROM (
          SELECT "jobId" FROM "ScoringBatchItem" WHERE status = 'leased' GROUP BY "jobId" HAVING COUNT(*) > 1
        ) duplicate_leases)::bigint AS "duplicateLeases",
        (SELECT COUNT(*) FROM "ScoringBatchItem" i JOIN "ScoringBatch" b ON b.id = i."batchId" WHERE i.stage <> b.stage)::bigint AS "stageMismatches",
        (SELECT COUNT(*) FROM "ScoringBatchItem" WHERE status = 'imported' AND "importedScoreEventId" IS NULL)::bigint AS "importedWithoutEvent",
        (SELECT COUNT(*) FROM "ScoringBatchItem" i JOIN "JobScoreEvent" e ON e.id = i."importedScoreEventId" WHERE e."batchItemId" <> i.id OR e."jobId" <> i."jobId")::bigint AS "eventBindingMismatches",
        (SELECT COUNT(*) FROM "JobScoreEvent" e JOIN "ScoringBatchItem" i ON i.id = e."batchItemId" WHERE e."evaluationType" = 'experience_fit' AND (e."sourceAimEventId" IS DISTINCT FROM i."sourceAimEventId" OR e."cleanedJdArtifactId" IS DISTINCT FROM i."cleanedArtifactId"))::bigint AS "experienceParentMismatches",
        (SELECT COUNT(*) FROM "ScoringBatch" b JOIN "ScoringBatchItem" i ON i."batchId" = b.id WHERE b.status = 'completed' AND i.status = 'leased')::bigint AS "completedWithLeases",
        (SELECT COUNT(*) FROM "ScoringBatch" WHERE status IN ('exported', 'superseded') AND "expiresAt" < NOW())::bigint AS "expiredOrSupersededActionNeeded",
        (SELECT COUNT(*) FROM "JobScoreEvent" WHERE "evaluationType" IN ('aim_fit', 'experience_fit') AND "staleAt" IS NOT NULL)::bigint AS "staleStagedEvents",
        (SELECT COUNT(*) FROM "JobScoringArtifact" WHERE "staleAt" IS NOT NULL)::bigint AS "staleArtifacts"
    `;
    staged = numbers(row);
  }

  const packageJson = fs.readFileSync('package.json', 'utf8');
  const pipelineRoute = fs.readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
  const nativeReachability = {
    packageExposesNativeScoring: /scoring:(?:request|next|prepare-phase|watch|canary)/.test(packageJson),
    pipelineCreatesNativeRequest: /createNativeScoringRequest/.test(pipelineRoute),
    hookRegistered: fs.existsSync('.agents/hooks.json') && /native-scoring-v6-boundary/.test(fs.readFileSync('.agents/hooks.json', 'utf8')),
  };

  const legacy = numbers(legacyRows[0]);
  const native = numbers(nativeRows[0]);
  const violations: string[] = [];
  if (!schemaReady) violations.push('manual_scoring_schema_missing');
  if (Object.entries(staged).some(([key, value]) => key !== 'expiredOrSupersededActionNeeded' && key !== 'staleStagedEvents' && key !== 'staleArtifacts' && value > 0)) violations.push('staged_integrity');
  if (legacy.legacyManualExportLeases > 0 || legacy.nativeJobLeases > 0) violations.push('legacy_scoring_leases');
  if (native.nonterminalRequests > 0 || native.activeKeys > native.failedActiveKeys) violations.push('active_native_request');
  if (native.failedActiveKeys > 0) violations.push('failed_native_active_key_requires_reconciliation');
  if (Object.values(nativeReachability).some(Boolean)) violations.push('native_scoring_reachable');

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(), schemaReady, legacy, native, staged, nativeReachability, violations, ready: violations.length === 0,
  }, null, 2));
  if (violations.length > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
