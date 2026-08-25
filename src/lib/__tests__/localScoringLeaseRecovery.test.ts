import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  LOCAL_SCORING_LEASE_STALE_AFTER_MS,
  recoverStaleLocalScoringLeases,
  staleLocalScoringLeaseCutoff,
} from '../localScoringLeaseRecovery';

type Row = {
  batchJobId: string | null;
  scoringStatus: string;
  updatedAt: Date;
};

type UpdateManyArgs = {
  where: {
    batchJobId: { not: null };
    scoringStatus: string;
    updatedAt: { lt: Date };
  };
  data: { batchJobId: null; scoringStatus: string };
};

function fakeClient(rows: Row[]) {
  const calls: UpdateManyArgs[] = [];
  const client = {
    job: {
      updateMany: async (args: UpdateManyArgs) => {
        calls.push(args);
        const matched = rows.filter((row) => row.batchJobId !== null
          && row.scoringStatus === args.where.scoringStatus
          && row.updatedAt < args.where.updatedAt.lt);
        for (const row of matched) {
          row.batchJobId = args.data.batchJobId;
          row.scoringStatus = args.data.scoringStatus;
        }
        return { count: matched.length };
      },
    },
  };
  return {
    calls,
    client: client as unknown as Parameters<typeof recoverStaleLocalScoringLeases>[1],
  };
}

test('recovery releases exactly stale local-scoring leases', async () => {
  const now = new Date('2026-08-24T18:00:00.000Z');
  const cutoff = staleLocalScoringLeaseCutoff(now);
  assert.equal(cutoff.getTime(), now.getTime() - LOCAL_SCORING_LEASE_STALE_AFTER_MS);

  const rows: Row[] = [
    { batchJobId: 'stale-lease', scoringStatus: 'scoring', updatedAt: new Date(cutoff.getTime() - 1) },
    { batchJobId: 'fresh-lease', scoringStatus: 'scoring', updatedAt: cutoff },
    { batchJobId: 'queued-lease', scoringStatus: 'queued', updatedAt: new Date(cutoff.getTime() - 1) },
    { batchJobId: null, scoringStatus: 'scoring', updatedAt: new Date(cutoff.getTime() - 1) },
  ];
  const { client, calls } = fakeClient(rows);

  assert.equal(await recoverStaleLocalScoringLeases(now, client), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, {
    batchJobId: { not: null },
    scoringStatus: 'scoring',
    updatedAt: { lt: cutoff },
  });
  assert.deepEqual(calls[0].data, { batchJobId: null, scoringStatus: 'queued' });
  assert.deepEqual(rows.map(({ batchJobId, scoringStatus }) => ({ batchJobId, scoringStatus })), [
    { batchJobId: null, scoringStatus: 'queued' },
    { batchJobId: 'fresh-lease', scoringStatus: 'scoring' },
    { batchJobId: 'queued-lease', scoringStatus: 'queued' },
    { batchJobId: null, scoringStatus: 'scoring' },
  ]);
});

test('full and Local-only pipeline entrypoints use the shared recovery helper', () => {
  const routes = [
    readFileSync(path.join(process.cwd(), 'src/app/api/pipeline/run/route.ts'), 'utf8'),
    readFileSync(path.join(process.cwd(), 'src/app/api/pipeline/local/route.ts'), 'utf8'),
  ];
  for (const route of routes) {
    assert.match(route, /import \{ recoverStaleLocalScoringLeases \} from '@\/lib\/localScoringLeaseRecovery'/);
    assert.match(route, /await recoverStaleLocalScoringLeases\(\)/);
    assert.doesNotMatch(
      route,
      /batchJobId: \{ not: null \}, scoringStatus: 'scoring', updatedAt: \{ lt:/,
    );
  }
});

test('standard repair-readiness command includes the operational partition audit', () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const readinessSource = readFileSync(
    path.join(process.cwd(), 'scripts/audit_manual_scoring_readiness.ts'),
    'utf8',
  );
  assert.equal(
    packageJson.scripts?.['audit:repair-readiness'],
    'node --import tsx scripts/audit_manual_scoring_readiness.ts',
  );
  assert.match(readinessSource, /operationalPartitionScopeWhere\(currentSuppressionIds\)/);
  assert.match(readinessSource, /violations\.push\('operational_queue_partition'\)/);
});
