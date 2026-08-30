import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TICKER_FALLBACK_MESSAGE,
  currentTickerMessage,
  describeAtsBatchChunk,
  describeAtsBatchJob,
  pipelineStatusRows,
  rollingTickerMessageQueue,
} from '../pipelineTelemetry';

test('the ticker preserves entered text and rolls the newest update in next', () => {
  assert.deepEqual(rollingTickerMessageQueue(
    ['ATS processing: visible-company', 'ATS processing: entering-company', 'ATS processing: unseen-copy'],
    2,
    'ATS processing: current-company - processing job 8 of 25',
  ), [
    'ATS processing: visible-company',
    'ATS processing: entering-company',
    'ATS processing: current-company - processing job 8 of 25',
  ]);
});

test('the ticker coalesces updates that have not entered the viewport yet', () => {
  assert.deepEqual(rollingTickerMessageQueue(
    ['ATS processing: visible-company', 'ATS processing: superseded-before-entry'],
    1,
    'ATS processing: newest-company',
  ), [
    'ATS processing: visible-company',
    'ATS processing: newest-company',
  ]);
});

test('blank ticker telemetry has one consistent fallback', () => {
  assert.equal(currentTickerMessage(''), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage('   '), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage(null), TICKER_FALLBACK_MESSAGE);
});

test('the expanded concurrent status has one stable row per pipeline lane', () => {
  assert.deepEqual(
    pipelineStatusRows(
      'Dejobs (source_feed/channel development manager): Navigating to page 2... | ATS acquisition PID 586172: bamboohr:tdh | Backpressure: Normal · 842 awaiting persistence (pauses at 2,000) · 21,221 awaiting enrichment · 14,900 still listing | ATS processing: ashby:dex - processing job 4 of 7 | Local Scoring: Locally filtered Example Co | JD Extraction: 0 queued',
    ),
    [
      { id: 'ingestion', label: 'Source ingestion', value: 'Dejobs (source_feed/channel development manager): Navigating to page 2...' },
      { id: 'ats-acquisition', label: 'ATS acquisition', value: 'PID 586172 · bamboohr:tdh' },
      { id: 'backpressure', label: 'Backpressure', value: 'Normal · 842 awaiting persistence (pauses at 2,000) · 21,221 awaiting enrichment · 14,900 still listing' },
      { id: 'ats-processing', label: 'ATS processing', value: 'ashby:dex - processing job 4 of 7' },
      { id: 'local-scoring', label: 'Local scoring', value: 'Locally filtered Example Co' },
      { id: 'jd-extraction', label: 'JD extraction', value: '0 queued' },
    ],
  );
});

test('the backpressure lane separates the gated stage from the rest of the backlog', () => {
  // The gate counts only jobs in synchronized payloads, which the persistence
  // stage keeps near zero. Reported alone it reads healthy at exactly the moment
  // acquisition is backed up, so the lane must name all three stages and mark
  // which one the watermark applies to.
  const [backpressure] = pipelineStatusRows(
    'Ingestion: idle | ATS acquisition PID 1: workday:acme | Backpressure: Normal \u00b7 0 awaiting persistence (pauses at 2,000) \u00b7 21,221 awaiting enrichment \u00b7 14,900 still listing | ATS processing: idle | Local Scoring: idle | JD Extraction: 0 queued',
  ).filter((row) => row.id === 'backpressure');
  assert.equal(
    backpressure.value,
    'Normal \u00b7 0 awaiting persistence (pauses at 2,000) \u00b7 21,221 awaiting enrichment \u00b7 14,900 still listing',
  );
  // A zero gate must not be presentable as an empty backlog.
  assert.match(backpressure.value, /21,221 awaiting enrichment/);
  assert.match(backpressure.value, /14,900 still listing/);
});

test('the expanded status preserves a backpressure lane for legacy five-lane telemetry', () => {
  const rows = pipelineStatusRows(
    'Ingestion: Idle | ATS acquisition: Ready | ATS processing: Idle | Local Scoring: Idle | JD Extraction: Idle',
  );

  assert.deepEqual(rows[2], {
    id: 'backpressure',
    label: 'Backpressure',
    value: 'Awaiting telemetry',
  });
  assert.equal(rows[3].value, 'Idle');
});

test('the expanded status keeps non-concurrent progress as one activity row', () => {
  assert.deepEqual(pipelineStatusRows('Initializing pipeline'), [
    { id: 'activity', label: 'Current activity', value: 'Initializing pipeline' },
  ]);
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
