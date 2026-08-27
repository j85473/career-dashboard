import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  atsBatchItemAuditFields,
  recoverAtsBatchItemOutcome,
} from '../jobIngestion';

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
