import assert from 'node:assert/strict';
import test from 'node:test';
import type { AtsDiscoveryLocalScan, PrismaClient } from '../prismaClient';
import { consumeLocalCrawlScan, finishLocalCrawlScan, saveLocalCrawlBlock } from '../localCommonCrawlAudit';
import { localCrawlConfig, localCrawlPlanHash, type LocalCrawlPlan } from '../localCommonCrawl';
import { completeLocalAuditCheckpoints } from '../../../scripts/audit_ats_common_crawl';
import { athenaDiscoveryConfig } from '../athenaCommonCrawl';

const indexId = 'CC-MAIN-2026-39-index';
const pattern = 'job-boards.greenhouse.io/*';
const config = localCrawlConfig();
const url = (slug: string) => ({ url: `https://job-boards.greenhouse.io/${slug}/posting` });

function harness(blockCount = 1) {
  const plan: LocalCrawlPlan = { version: 1, indexId, manifestSha256: 'a'.repeat(64), directoryBytes: 100,
    patterns: [{ platform: 'greenhouse', pattern }], compressedBytes: 100 * blockCount,
    blocks: Array.from({ length: blockCount }, (_, i) => ({ key: `io,greenhouse)/${i}`, endKey: null, shard: 'cdx-00000.gz', offset: i * 100, length: 100, patterns: [0] })) };
  let scan: AtsDiscoveryLocalScan = { runId: 'run', indexId, planHash: localCrawlPlanHash(plan), plan: JSON.parse(JSON.stringify(plan)),
    stats: [{ blocksRead: 0, recordsRead: 0, candidatesQueued: 0 }], nextBlock: 0, status: 'running', createdAt: new Date(0), updatedAt: new Date(0), completedAt: null };
  let candidates = new Map<string, Record<string, unknown>>();
  let receipts = new Map<string, unknown>(); let total = 0;
  let checkpoint = { page: 7, indexId: 'CC-MAIN-2026-34-index', athenaExecutionId: 'paid-existing', athenaNextToken: 'saved-page', completedThrough: null as string | null };
  const controls = { failRunWrite: false, failReceipt: false, failDelete: false };
  const removed: string[] = []; const read: number[] = [];
  const db = {
    atsDiscoveryLocalScan: {
      updateMany: async ({ where, data }: { where: { nextBlock: number }; data: Partial<AtsDiscoveryLocalScan> }) => {
        if (scan.nextBlock !== where.nextBlock) return { count: 0 };
        scan = { ...scan, ...data }; return { count: 1 };
      },
      update: async ({ data }: { data: Partial<AtsDiscoveryLocalScan> }) => { scan = { ...scan, ...data }; return structuredClone(scan); },
      findUniqueOrThrow: async () => structuredClone(scan),
    },
    atsDiscoveryAuditCandidate: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      let count = 0;
      for (const row of data) if (!candidates.has(String(row.slug))) { candidates.set(String(row.slug), row); count++; }
      return { count };
    } },
    atsFirstCollectionCandidate: { createMany: async () => ({ count: 0 }) },
    atsDiscoveryAuditRun: { update: async ({ data }: { data: { candidatesQueued?: { increment: number } } }) => {
      if (controls.failRunWrite) throw new Error('database write failed');
      total += data.candidatesQueued?.increment || 0;
    } },
    atsDiscoveryAuditIndexReceipt: {
      upsert: async ({ create }: { create: { pattern: string } }) => {
        if (controls.failReceipt) throw new Error('receipt write failed');
        if (!receipts.has(create.pattern)) receipts.set(create.pattern, create);
      },
      findMany: async () => [...receipts.values()],
    },
    atsDiscoveryAuditCheckpoint: { upsert: async ({ update }: { update: { completedThrough: string } }) => { checkpoint = { ...checkpoint, ...update }; } },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      const before = structuredClone({ scan, candidates, receipts, total, checkpoint });
      try { return await work(db); } catch (error) {
        ({ scan, candidates, receipts, total, checkpoint } = before); throw error;
      }
    },
  };
  const client = db as unknown as PrismaClient;
  const dependencies = {
    readBlock: async (_plan: LocalCrawlPlan, ordinal: number) => { read.push(ordinal); return [url('Acme'), url('Acme'), url('acme'), { url: 'https://attacker.com/fake' }]; },
    saveBlock: saveLocalCrawlBlock, finish: finishLocalCrawlScan,
    remove: async (filename: string) => { if (controls.failDelete) throw new Error('delete failed'); removed.push(filename); },
    space: async () => {}, wait: async () => {},
  };
  return { client, dependencies, controls, removed, read, scan: () => structuredClone(scan), candidates: () => [...candidates.values()],
    receipts: () => [...receipts.values()], total: () => total, checkpoint: () => checkpoint,
    consume: () => consumeLocalCrawlScan(client, structuredClone(scan), config, async () => {}, dependencies),
    addReceipt: (value: unknown) => receipts.set(pattern, value) };
}

test('a failed database save rolls back candidates and cursor and cannot delete its block', async () => {
  const h = harness(); h.controls.failRunWrite = true;
  await assert.rejects(h.consume(), /database write failed/);
  assert.equal(h.scan().nextBlock, 0); assert.deepEqual(h.candidates(), []); assert.deepEqual(h.removed, []); assert.deepEqual(h.receipts(), []);
  h.controls.failRunWrite = false; await h.consume();
  assert.equal(h.scan().nextBlock, 1); assert.equal(h.scan().status, 'complete');
  assert.equal(h.candidates().length, 2); assert.equal(h.total(), 2); assert.equal(h.removed.length, 1);
  assert.equal(h.candidates()[0].sourceUrl, url('Acme').url); assert.equal(h.candidates()[0].sourceIndexId, indexId);
});

test('a crash after commit but before deletion resumes after the saved block without double counts', async () => {
  const h = harness(2); h.controls.failDelete = true;
  await assert.rejects(h.consume(), /delete failed/);
  assert.equal(h.scan().nextBlock, 1); assert.equal(h.total(), 2);
  h.controls.failDelete = false; await h.consume();
  assert.deepEqual(h.read, [0, 1]); assert.equal(h.total(), 2); assert.equal(h.receipts().length, 1);
});

test('a stale worker cannot advance or count an already committed block again', async () => {
  const h = harness(2); const original = h.scan();
  await saveLocalCrawlBlock(h.client, original, [url('acme')]);
  await assert.rejects(saveLocalCrawlBlock(h.client, original, [url('other')]), /Another worker/);
  assert.equal(h.scan().nextBlock, 1); assert.equal(h.candidates().length, 1); assert.equal(h.total(), 1);
});

test('unread blocks and failed receipt writes cannot earn completion', async () => {
  const h = harness();
  await assert.rejects(finishLocalCrawlScan(h.client, h.scan()), /unread blocks/);
  await saveLocalCrawlBlock(h.client, h.scan(), [url('acme')]); h.controls.failReceipt = true;
  await assert.rejects(finishLocalCrawlScan(h.client, h.scan()), /receipt write failed/);
  assert.equal(h.scan().status, 'running'); assert.deepEqual(h.receipts(), []);
  h.controls.failReceipt = false; await finishLocalCrawlScan(h.client, h.scan());
  assert.equal(h.scan().status, 'complete'); assert.equal(h.receipts().length, 1);
});

test('an empty verified plan earns a zero-result receipt and completion stays idempotent', async () => {
  const h = harness(0); await h.consume(); await h.consume();
  assert.equal(h.read.length, 0); assert.equal(h.receipts().length, 1);
  assert.deepEqual(h.receipts()[0], { runId: 'run', indexId, platform: 'greenhouse', pattern, pagesRead: 0, recordsRead: 0, candidatesQueued: 0 });
});

test('run completion requires every exact receipt and preserves both previous source cursors', async () => {
  const h = harness(); const run = { id: 'run', targetIndexId: indexId, indexCount: 1, patternCount: 1 } as Parameters<typeof completeLocalAuditCheckpoints>[1];
  const work = [{ platformKey: 'greenhouse' as const, pattern }];
  await assert.rejects(completeLocalAuditCheckpoints(h.client, run, [indexId], work), /lacks an exact/);
  const before = h.checkpoint(); await h.consume();
  await completeLocalAuditCheckpoints(h.client, run, [indexId], work);
  assert.deepEqual(h.checkpoint(), { ...before, completedThrough: indexId });
  await assert.rejects(completeLocalAuditCheckpoints(h.client, run, [indexId, 'CC-MAIN-2026-34-index'], work), /scope does not match/);
});

test('local mode does not create an Athena reader even with old AWS settings present', () => {
  assert.equal(athenaDiscoveryConfig({ ATS_DISCOVERY_SOURCE: 'local', ATS_DISCOVERY_ATHENA_REGION: 'us-east-1', ATS_DISCOVERY_ATHENA_WORKGROUP: 'old' }), null);
});

test('low scratch space stops before downloading, saving, deleting or earning a receipt', async () => {
  const h = harness();
  h.dependencies.space = async () => { throw new Error('preserve free space'); };
  await assert.rejects(h.consume(), /preserve free space/);
  assert.deepEqual(h.read, []); assert.deepEqual(h.removed, []); assert.deepEqual(h.receipts(), []);
  assert.equal(h.scan().nextBlock, 0);
});
