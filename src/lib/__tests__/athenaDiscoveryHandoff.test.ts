import assert from 'node:assert/strict';
import test from 'node:test';
import type { AtsDiscoveryAuditCheckpoint, AtsDiscoveryAuditRun, PrismaClient } from '@prisma/client';
import type { AthenaCommonCrawlReader } from '../athenaCommonCrawl';
import {
  auditIndicesMissingCoverage,
  auditWorkItems,
  createOrResumeRun,
  crawlPatternQuantum,
  type AuditWorkItem,
} from '../../../scripts/audit_ats_common_crawl';

const indexId = 'CC-MAIN-2026-34-index';
const olderIndex = 'CC-MAIN-2026-26-index';
const pattern = 'job-boards.greenhouse.io/*';
const url = (slug: string) => `https://job-boards.greenhouse.io/${slug}/posting`;
type Reader = Pick<AthenaCommonCrawlReader, 'start' | 'state' | 'results'>;

function harness(initial: Partial<AtsDiscoveryAuditCheckpoint> = {}) {
  let checkpoint: AtsDiscoveryAuditCheckpoint = {
    runId: 'run', platform: 'greenhouse', pattern, indexId,
    page: 0, indexPagesRead: 0, indexRecordsRead: 0, indexCandidatesQueued: 0,
    failureCount: 0, nextAttemptAt: new Date(0), lastError: null,
    athenaExecutionId: 'query-1', athenaRequestToken: 'saved-token',
    athenaNextToken: null, athenaResultsComplete: false, completedThrough: null,
    updatedAt: new Date(0), ...initial,
  };
  let candidates = new Map<string, unknown>();
  let receipts: unknown[] = [];
  const submissions: Array<{ index: string; pattern: string; token: string }> = [];
  const executions = new Map<string, string>();
  const cdxPages: number[] = [];
  const controls = {
    failTokenWrite: false, failExecutionWrite: false, failProgressWrite: false,
    loseSubmissionResponse: false,
  };
  const database = {
    atsDiscoveryAuditCheckpoint: {
      upsert: async () => ({ ...checkpoint }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (controls.failTokenWrite && data.athenaRequestToken) throw new Error('token write failed');
        if (controls.failExecutionWrite && data.athenaExecutionId) throw new Error('execution write failed');
        if (controls.failProgressWrite && data.indexPagesRead) throw new Error('progress write failed');
        for (const [key, value] of Object.entries(data)) {
          const state = checkpoint as unknown as Record<string, unknown>;
          state[key] = typeof value === 'object' && value !== null && 'increment' in value
            ? Number(state[key]) + Number(value.increment) : value;
        }
        return { ...checkpoint };
      },
    },
    atsDiscoveryAuditCandidate: {
      createMany: async ({ data }: { data: Array<{ slug: string }> }) => {
        let count = 0;
        for (const row of data) if (!candidates.has(row.slug)) { candidates.set(row.slug, row); count++; }
        return { count };
      },
    },
    atsDiscoveryAuditIndexReceipt: { upsert: async (args: unknown) => { receipts.push(args); } },
    atsDiscoveryAuditRun: { update: async () => ({}) },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      const before = { checkpoint: { ...checkpoint }, candidates: new Map(candidates), receipts: [...receipts] };
      try { return await work(database); }
      catch (error) {
        checkpoint = before.checkpoint; candidates = before.candidates; receipts = before.receipts;
        throw error;
      }
    },
  };
  const reader: Reader = {
    start: async (index, submittedPattern, token) => {
      submissions.push({ index, pattern: submittedPattern, token });
      if (!executions.has(token)) executions.set(token, `query-${executions.size + 2}`);
      if (controls.loseSubmissionResponse) throw new Error('connection lost after query accepted');
      return executions.get(token)!;
    },
    state: async () => ({ state: 'SUCCEEDED', reason: null }),
    results: async () => ({ urls: [url('acme')], nextToken: null }),
  };
  const dependencies = {
    client: database as unknown as PrismaClient,
    reader: reader as Reader | null,
    fetchPage: async (_index: string, _pattern: string, page: number) => {
      cdxPages.push(page);
      return { ok: true as const, records: page === 0 ? [{ url: url('acme') }, { url: url('unread') }] : [] };
    },
    processReady: async () => 0,
    wait: async () => {},
  };
  return {
    reader, dependencies, controls, submissions, executions, cdxPages,
    checkpoint: () => checkpoint, candidates: () => [...candidates.keys()], receipts: () => receipts,
    quantum: (indices = [indexId], targetIndexId = indices.at(-1)!) => {
      checkpoint.nextAttemptAt = new Date(0);
      return crawlPatternQuantum('run', targetIndexId, indices, 'greenhouse', pattern, dependencies);
    },
  };
}

test('switching Athena to CDX starts at its own offset and switching back retains the Athena cursor', async () => {
  const h = harness();
  h.reader.results = async (_execution, token) => token
    ? { urls: [url('unread')], nextToken: null }
    : { urls: [url('acme')], nextToken: 'athena-page-2' };
  await h.quantum();
  assert.equal(h.checkpoint().page, 0);
  assert.equal(h.checkpoint().athenaNextToken, 'athena-page-2');
  h.dependencies.reader = null;
  await h.quantum();
  assert.deepEqual(h.cdxPages, [0]);
  assert.equal(h.checkpoint().page, 1);
  assert.equal(h.checkpoint().athenaNextToken, 'athena-page-2');
  assert.deepEqual(h.candidates(), ['acme', 'unread']);
  h.dependencies.reader = h.reader;
  await h.quantum();
  assert.equal(h.checkpoint().page, 1);
  assert.equal(h.checkpoint().athenaResultsComplete, true);
  assert.equal(h.checkpoint().indexCandidatesQueued, 2);
  assert.equal((await h.quantum()).kind, 'complete');
  assert.equal(h.receipts().length, 1);
});

test('an existing partially read CDX index retains its offset throughout an Athena scan', async () => {
  const h = harness({ page: 7, athenaExecutionId: null, athenaRequestToken: null });
  await h.quantum();
  await h.quantum();
  assert.equal(h.checkpoint().page, 7);
  h.dependencies.reader = null;
  await h.quantum();
  assert.deepEqual(h.cdxPages, [7]);
});

test('a CDX-only legacy collection keeps its own cursor and earns a receipt only after direct source exhaustion', async () => {
  const legacy = 'CC-MAIN-2008-2009-index';
  const h = harness({ indexId: legacy, athenaExecutionId: null, athenaRequestToken: null });
  h.reader.state = async () => { throw new Error('legacy collections must not contact Athena'); };
  assert.equal((await h.quantum([legacy])).kind, 'advanced');
  assert.deepEqual(h.cdxPages, [0]);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.checkpoint().page, 1);
  assert.equal(h.receipts().length, 0);
  assert.deepEqual(h.candidates(), ['acme', 'unread']);
  assert.equal((await h.quantum([legacy])).kind, 'complete');
  assert.deepEqual(h.cdxPages, [0, 1]);
  assert.equal(h.receipts().length, 1);
});

for (const failingOperation of ['state', 'results'] as const) {
  test(`a temporary Athena ${failingOperation} error retains the execution and result cursor`, async () => {
    const h = harness({ athenaNextToken: 'page-8', page: 3 });
    h.reader[failingOperation] = async () => { throw new Error('temporary AWS read failure'); };
    for (let retry = 0; retry < 2; retry++) {
      assert.equal((await h.quantum()).kind, 'deferred');
      assert.equal(h.checkpoint().athenaExecutionId, 'query-1');
      assert.equal(h.checkpoint().athenaRequestToken, 'saved-token');
      assert.equal(h.checkpoint().athenaNextToken, 'page-8');
      assert.equal(h.checkpoint().page, 3);
    }
    assert.equal(h.submissions.length, 0);
    assert.equal(h.receipts().length, 0);
  });
}

test('an unknown Athena state retains the query rather than resubmitting it', async () => {
  const h = harness();
  h.reader.state = async () => ({ state: 'UNKNOWN', reason: 'no state returned' });
  await h.quantum();
  assert.equal(h.checkpoint().athenaExecutionId, 'query-1');
  assert.equal(h.checkpoint().athenaRequestToken, 'saved-token');
});

for (const state of ['QUEUED', 'RUNNING'] as const) {
  test(`a ${state} query waits without replacing its submission or earning a receipt`, async () => {
    const h = harness({ athenaNextToken: 'saved-page' });
    h.reader.state = async () => ({ state, reason: null });
    assert.equal((await h.quantum()).kind, 'deferred');
    assert.equal(h.checkpoint().failureCount, 0);
    assert.equal(h.checkpoint().athenaNextToken, 'saved-page');
    assert.equal(h.checkpoint().athenaRequestToken, 'saved-token');
    assert.equal(h.submissions.length, 0);
    assert.equal(h.receipts().length, 0);
  });
}

test('an AWS exception with an empty message cannot be interpreted as exhausted results', async () => {
  const h = harness();
  h.reader.state = async () => { throw new Error(''); };
  assert.equal((await h.quantum()).kind, 'deferred');
  assert.equal(h.receipts().length, 0);
  assert.equal(h.checkpoint().completedThrough, null);
});

for (const state of ['FAILED', 'CANCELLED', 'SUCCEEDED'] as const) {
  test(`a ${state === 'SUCCEEDED' ? 'verified expired' : state} query permits one new token without clearing candidates or CDX progress`, async () => {
    const h = harness({ page: 7 });
    await h.quantum();
    // Keep a candidate already durably read, but simulate a later page failure.
    h.checkpoint().athenaResultsComplete = false;
    h.reader.state = async () => ({ state, reason: 'terminal', resultsExpired: state === 'SUCCEEDED' });
    await h.quantum();
    assert.equal(h.checkpoint().athenaExecutionId, null);
    assert.equal(h.checkpoint().athenaRequestToken, null);
    assert.equal(h.checkpoint().athenaNextToken, null);
    assert.equal(h.checkpoint().page, 7);
    assert.deepEqual(h.candidates(), ['acme']);
    await h.quantum();
    assert.equal(h.submissions.length, 1);
    assert.notEqual(h.submissions[0].token, 'saved-token');
    assert.equal(h.submissions[0].index, indexId);
    assert.equal(h.submissions[0].pattern, pattern);
  });
}

for (const failure of ['loseSubmissionResponse', 'failExecutionWrite'] as const) {
  test(`${failure} retries the saved submission token and recovers the same accepted query`, async () => {
    const h = harness({ athenaExecutionId: null, athenaRequestToken: null });
    h.controls[failure] = true;
    assert.equal((await h.quantum()).kind, 'deferred');
    const token = h.checkpoint().athenaRequestToken;
    assert.ok(token);
    assert.equal(h.checkpoint().athenaExecutionId, null);
    h.controls[failure] = false;
    assert.equal((await h.quantum()).kind, 'advanced');
    assert.equal(h.executions.size, 1);
    assert.equal(h.submissions.length, 2);
    assert.ok(h.submissions.every(submission => submission.token === token));
    assert.equal(h.checkpoint().athenaExecutionId, h.executions.get(token));
  });
}

test('a failed submission-token write cannot contact AWS', async () => {
  const h = harness({ athenaExecutionId: null, athenaRequestToken: null });
  h.controls.failTokenWrite = true;
  await assert.rejects(h.quantum(), /token write failed/);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.checkpoint().athenaRequestToken, null);
});

test('candidates and an Athena cursor roll back together when the progress write fails', async () => {
  const h = harness();
  h.reader.results = async () => ({ urls: [url('acme')], nextToken: 'page-2' });
  h.controls.failProgressWrite = true;
  await assert.rejects(h.quantum(), /progress write failed/);
  assert.deepEqual(h.candidates(), []);
  assert.equal(h.checkpoint().athenaNextToken, null);
  h.controls.failProgressWrite = false;
  await h.quantum();
  assert.deepEqual(h.candidates(), ['acme']);
  assert.equal(h.checkpoint().athenaNextToken, 'page-2');
});

test('an empty Athena page with a continuation token cannot earn a completion receipt', async () => {
  const h = harness();
  h.reader.results = async () => ({ urls: [], nextToken: 'nonempty-next-page' });
  assert.equal((await h.quantum()).kind, 'advanced');
  assert.equal(h.checkpoint().athenaNextToken, 'nonempty-next-page');
  assert.equal(h.receipts().length, 0);
});

test('advancing to another index resets both source cursors and uses a new submission token', async () => {
  const newest = 'CC-MAIN-2026-39-index';
  const h = harness({ page: 7, athenaResultsComplete: true });
  assert.equal((await h.quantum([indexId, newest])).kind, 'advanced');
  assert.equal(h.receipts().length, 1);
  assert.equal(h.checkpoint().indexId, newest);
  assert.equal(h.checkpoint().page, 0);
  assert.equal(h.checkpoint().athenaExecutionId, null);
  assert.equal(h.checkpoint().athenaRequestToken, null);
  assert.equal(h.checkpoint().athenaResultsComplete, false);
  await h.quantum([indexId, newest]);
  assert.equal(h.submissions[0].index, newest);
  assert.notEqual(h.submissions[0].token, 'saved-token');
});

const workItems: AuditWorkItem[] = [{ platformKey: 'greenhouse', pattern }];
const receipt = (receiptPattern = pattern, receiptIndex = indexId, platform = 'greenhouse') => ({
  platform, pattern: receiptPattern, indexId: receiptIndex,
});

test('equal pattern counts cannot transfer a completed old host receipt to a replacement host', () => {
  assert.deepEqual(auditIndicesMissingCoverage([olderIndex, indexId], workItems, [
    receipt('retired-host.example/*', olderIndex), receipt('retired-host.example/*'),
  ]), [olderIndex, indexId]);
});

test('a pattern added during an incremental run still requires its missing historical indexes', () => {
  assert.deepEqual(auditIndicesMissingCoverage([olderIndex, indexId], workItems, [receipt()]), [olderIndex, indexId]);
});

test('coverage combines exact completed receipts across runs and scans only newly published indexes', () => {
  const newest = 'CC-MAIN-2026-39-index';
  assert.deepEqual(auditIndicesMissingCoverage([olderIndex, indexId, newest], workItems, [
    receipt(pattern, olderIndex), receipt(),
  ]), [newest]);
  assert.deepEqual(auditIndicesMissingCoverage([olderIndex, indexId], workItems, [
    receipt(pattern, olderIndex), receipt(),
  ]), []);
  assert.deepEqual(auditIndicesMissingCoverage([indexId], workItems, [receipt(pattern, indexId, 'lever')]), [indexId]);
});

test('run creation uses completed exact receipts and saves every pattern before the first request', async () => {
  type CreatedRun = { indexCount: number; checkpoints: { create: Array<{ platform: string; pattern: string; indexId: string }> } };
  type ReceiptSelection = { where: { run: { status: { in: string[] } }; OR: Array<{ platform: string; pattern: string }> } };
  let created: CreatedRun | undefined;
  let selection: ReceiptSelection | undefined;
  const client = {
    atsDiscoveryAuditIndexReceipt: { findMany: async (args: ReceiptSelection) => {
      selection = args;
      return [receipt(pattern, olderIndex)];
    } },
    atsDiscoveryAuditRun: { create: async (args: { data: CreatedRun }) => { created = args.data; return { id: 'new-run', ...args.data }; } },
  } as unknown as PrismaClient;
  await createOrResumeRun([olderIndex, indexId], null, workItems, client);
  assert.deepEqual(selection?.where.run.status.in, ['complete', 'complete_with_unresolved']);
  assert.deepEqual(selection?.where.OR, [{ platform: 'greenhouse', pattern }]);
  assert.equal(created?.indexCount, 1);
  assert.deepEqual(created?.checkpoints.create, [{ platform: 'greenhouse', pattern, indexId }]);
});

test('fully covered patterns create no additional audit run', async () => {
  const client = {
    atsDiscoveryAuditIndexReceipt: { findMany: async () => [receipt()] },
    atsDiscoveryAuditRun: { create: async () => { throw new Error('must not create covered work'); } },
  } as unknown as PrismaClient;
  assert.equal(await createOrResumeRun([indexId], null, workItems, client), null);
});

test('an unfinished run keeps a saved host even after its configured pattern is replaced', async () => {
  const client = {
    atsDiscoveryAuditCheckpoint: { findMany: async () => [{ platform: 'greenhouse', pattern: 'saved-old-host.example/*' }] },
  } as unknown as PrismaClient;
  const items = await auditWorkItems({ id: 'run' } as AtsDiscoveryAuditRun, client);
  assert.ok(items.some(item => item.platformKey === 'greenhouse' && item.pattern === 'saved-old-host.example/*'));
  assert.ok(items.some(item => item.platformKey === 'greenhouse' && item.pattern === pattern));
});
