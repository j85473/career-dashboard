import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TICKER_FALLBACK_MESSAGE,
  currentTickerMessage,
  describeAtsBatchChunk,
  describeAtsBatchJob,
  synchronizeTickerMessageNodes,
} from '../pipelineTelemetry';

test('the marquee refreshes every already-rendered message copy', () => {
  const nodes = [
    { textContent: 'ATS processing: stale-company' },
    { textContent: 'ATS processing: stale-company' },
    { textContent: 'ATS processing: stale-company' },
  ];

  const current = synchronizeTickerMessageNodes(
    nodes,
    'ATS processing: current-company - processing job 8 of 25',
  );

  assert.equal(current, 'ATS processing: current-company - processing job 8 of 25');
  assert.deepEqual(nodes.map((node) => node.textContent), [current, current, current]);
});

test('blank ticker telemetry has one consistent fallback', () => {
  assert.equal(currentTickerMessage(''), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage('   '), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage(null), TICKER_FALLBACK_MESSAGE);
});

test('ATS processing describes the durable chunk instead of another network search', () => {
  const batch = {
    platform: 'workday',
    slug: 'example.wd1::careers',
    jobs: Array.from({ length: 25 }),
    processingOffset: 25,
    totalJobCount: 72,
  };

  assert.equal(
    describeAtsBatchChunk(batch),
    'workday:example.wd1::careers - processing jobs 26-50 of 72',
  );
  assert.equal(
    describeAtsBatchJob(batch, 4),
    'workday:example.wd1::careers - processing job 30 of 72',
  );
});

test('ATS processing labels an empty synchronized batch truthfully', () => {
  assert.equal(
    describeAtsBatchChunk({
      platform: 'greenhouse',
      slug: 'empty-board',
      jobs: [],
      processingOffset: 0,
      totalJobCount: 0,
    }),
    'greenhouse:empty-board - processing synchronized empty batch',
  );
});
