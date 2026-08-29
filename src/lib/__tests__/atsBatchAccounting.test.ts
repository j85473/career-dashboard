import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_PREFETCHED_JOB_WAVE_CONCURRENCY,
  atsBatchItemAuditFields,
  processAtsItemsInBoundedWaves,
  recoverAtsBatchItemOutcome,
} from '../jobIngestion';

test('prefetched ATS jobs fill the bounded write width and checkpoint whole waves', async () => {
  let active = 0;
  let maximumActive = 0;
  const prefixes: number[] = [];
  const completed = await processAtsItemsInBoundedWaves({
    items: Array.from({ length: 9 }, (_, index) => index),
    concurrency: 100,
    processItem: async (item) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, item % 2));
      active--;
      return 'inserted';
    },
    onWaveReconciled: (prefix) => {
      prefixes.push(prefix);
    },
  });

  assert.equal(ATS_PREFETCHED_JOB_WAVE_CONCURRENCY, 4);
  assert.equal(maximumActive, 4);
  assert.equal(completed, 9);
  assert.deepEqual(prefixes, [4, 8, 9]);
});

test('a rejected ATS wave joins every started job and checkpoints none of that wave', async () => {
  let siblingFinished = false;
  const prefixes: number[] = [];
  await assert.rejects(processAtsItemsInBoundedWaves({
    items: [0, 1, 2],
    concurrency: 2,
    processItem: async (_, index) => {
      if (index === 0) throw new Error('first item failed');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      siblingFinished = true;
      return 'duplicate';
    },
    onWaveReconciled: (prefix) => {
      prefixes.push(prefix);
    },
  }), /first item failed/);

  assert.equal(siblingFinished, true);
  assert.deepEqual(prefixes, []);
});

test('an ATS item without an atomic outcome leaves its whole wave for retry', async () => {
  let started = 0;
  const prefixes: number[] = [];
  await assert.rejects(processAtsItemsInBoundedWaves({
    items: [0, 1, 2],
    concurrency: 2,
    processItem: async (_, index) => {
      started++;
      return index === 1 ? undefined : 'filtered';
    },
    onWaveReconciled: (prefix) => {
      prefixes.push(prefix);
    },
  }), /did not reconcile every job/);

  assert.equal(started, 2);
  assert.deepEqual(prefixes, []);
});

test('prefetched ATS audit identity distinguishes repeated source ids by payload ordinal', () => {
  const first = atsBatchItemAuditFields({ batchId: 'batch-1', itemIndex: 4 });
  const repeatedSourceId = atsBatchItemAuditFields({ batchId: 'batch-1', itemIndex: 5 });

  assert.deepEqual(first, {
    atsBatchId: 'batch-1',
    atsBatchItemIndex: 4,
    atsBatchItemKey: 'batch-1:4',
  });
  assert.notEqual(first.atsBatchItemKey, repeatedSourceId.atsBatchItemKey);
});

test('prefetched ATS retry recovers the original atomic outcome from the exact batch item event', async () => {
  const queries: unknown[] = [];
  const input = {
    batchId: 'batch-1',
    itemIndex: 4,
    jobId: 'job-3',
    source: 'ATS-greenhouse',
    sourceId: 'posting-9',
  };

  const inserted = await recoverAtsBatchItemOutcome(input, async (args) => {
    queries.push(args);
    return { eventType: 'ingested' };
  });
  const filtered = await recoverAtsBatchItemOutcome(input, async () => ({
    eventType: 'prefilter_rejected',
  }));
  const absent = await recoverAtsBatchItemOutcome(input, async () => null);

  assert.equal(inserted, 'inserted');
  assert.equal(filtered, 'filtered');
  assert.equal(absent, null);
  assert.deepEqual(queries, [{
    where: {
      jobId: 'job-3',
      source: 'ATS-greenhouse',
      sourceId: 'posting-9',
      eventType: { in: ['ingested', 'prefilter_rejected'] },
      details: { path: ['atsBatchItemKey'], equals: 'batch-1:4' },
    },
    select: { eventType: true },
  }]);
});

test('batch outcome recovery runs before dedupe and atomic outcome events carry the batch item identity', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const processor = source.slice(
    source.indexOf('async function processJobInternal('),
    source.indexOf('async function processJob(', source.indexOf('async function processJobInternal(')),
  );

  const observationIndex = processor.indexOf('const obs = await prisma.jobSourceObservation.findUnique({');
  const recoveryIndex = processor.indexOf('const recoveredOutcome = await recoverAtsBatchItemOutcome({');
  const duplicateBranchIndex = processor.indexOf('if (obs) {', recoveryIndex);
  assert.ok(recoveryIndex >= 0, 'prefetched batch recovery is missing');
  assert.ok(observationIndex >= 0 && recoveryIndex > observationIndex, 'recovery must use the indexed observed Job');
  assert.match(
    processor.slice(observationIndex, recoveryIndex),
    /if \(atsBatchItem && obs\) \{/,
    'brand-new rows must not pay for an event lookup',
  );
  assert.ok(duplicateBranchIndex > recoveryIndex, 'original outcome must be recovered before duplicate handling');

  const prefilterEvent = processor.slice(
    processor.indexOf("eventType: 'prefilter_rejected'"),
    processor.indexOf("identityParts: [runIdentity]", processor.indexOf("eventType: 'prefilter_rejected'")),
  );
  const ingestedEvent = processor.slice(
    processor.indexOf("eventType: 'ingested'"),
    processor.indexOf("identityParts: [runIdentity]", processor.indexOf("eventType: 'ingested'")),
  );
  assert.match(prefilterEvent, /atsBatchItemAuditFields\(atsBatchItem\)/);
  assert.match(ingestedEvent, /atsBatchItemAuditFields\(atsBatchItem\)/);
  assert.match(
    source,
    /itemIndex: options\.prefetchedAtsBatch\.processingOffset \+ batchJobIndex/,
  );
});

test('only prefetched ATS jobs use bounded waves and batch completion uses the reconciled prefix', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  assert.match(
    source,
    /if \(options\.prefetchedAtsBatch\) \{\s+await processAtsItemsInBoundedWaves\(\{/,
  );
  assert.match(
    source,
    /else \{\s+for \(const \[batchJobIndex, job\] of jobs\.entries\(\)\) \{\s+await processAtsJob\(job, batchJobIndex\)/,
  );
  assert.match(source, /prefetchedReconciledCounters = aggregateCounters\(\)/);
  assert.match(source, /const counters = prefetchedReconciledCounters \?\? aggregateCounters\(\)/);
});
