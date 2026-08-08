import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  currentBatchId,
  EMPTY_BATCH_PROGRESS,
  summarizeBatchDirectory,
} from '../nativeScoringBatchProgress';

const BATCH_ID = 'native_bd298de5-f544-449d-8ba3-76a7c77713f1_standard_c0a39a47';

function buildBatch(files: { chunks: string[]; results: string[]; quarantine: string[] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runs-'));
  for (const [directory, names] of Object.entries(files)) {
    const target = path.join(root, BATCH_ID, directory);
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(target, name), '{}');
  }
  return root;
}

const chunkNames = (count: number) =>
  Array.from({ length: count }, (_, index) => `chunk_${String(index).padStart(4, '0')}.json`);
const resultNames = (count: number) =>
  Array.from({ length: count }, (_, index) => `chunk_${String(index).padStart(4, '0')}.result.json`);

test('progress counts completed chunk results against the manifest chunks', () => {
  const root = buildBatch({ chunks: chunkNames(20), results: resultNames(12), quarantine: [] });
  const progress = summarizeBatchDirectory(BATCH_ID, root);
  assert.equal(progress.chunksTotal, 20);
  assert.equal(progress.chunksDone, 12);
  assert.equal(progress.quarantineRetries, 0);
});

test('quarantine files count retries while distinct ids count troubled chunks', () => {
  const root = buildBatch({
    chunks: chunkNames(20),
    results: resultNames(20),
    quarantine: [
      'chunk_0007.2026-08-08T13-39-16-079Z.invalid.json',
      'chunk_0007.2026-08-08T13-40-04-108Z.invalid.json',
      'chunk_0016.2026-08-08T13-40-45-017Z.invalid.json',
    ],
  });
  const progress = summarizeBatchDirectory(BATCH_ID, root);
  assert.equal(progress.quarantineRetries, 3);
  assert.equal(progress.quarantineChunks, 2);
});

test('completed chunks never exceed the chunk count', () => {
  const root = buildBatch({ chunks: chunkNames(5), results: resultNames(20), quarantine: [] });
  assert.equal(summarizeBatchDirectory(BATCH_ID, root).chunksDone, 5);
});

test('a traversal batch id reads nothing instead of escaping the root', () => {
  const root = buildBatch({ chunks: chunkNames(3), results: [], quarantine: [] });
  for (const hostile of ['../../etc', `../${BATCH_ID}`, `${BATCH_ID}/../..`, '/etc/passwd']) {
    assert.deepEqual(summarizeBatchDirectory(hostile, root), EMPTY_BATCH_PROGRESS);
  }
});

test('a missing or empty batch directory reports no progress instead of throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runs-'));
  assert.deepEqual(summarizeBatchDirectory(BATCH_ID, root), EMPTY_BATCH_PROGRESS);
  assert.deepEqual(summarizeBatchDirectory(null, root), EMPTY_BATCH_PROGRESS);
});

test('a wave that finishes between heartbeats still summarises as complete', () => {
  // The runner marks the request finished itself, so the closing snapshot is the
  // only chance to record the last chunk; without it the bar froze mid-wave.
  const root = buildBatch({ chunks: chunkNames(7), results: resultNames(6), quarantine: [] });
  assert.equal(summarizeBatchDirectory(BATCH_ID, root).chunksDone, 6);

  fs.writeFileSync(path.join(root, BATCH_ID, 'results', 'chunk_0006.result.json'), '{}');
  const closing = summarizeBatchDirectory(BATCH_ID, root);
  assert.equal(closing.chunksDone, 7);
  assert.equal(closing.chunksTotal, 7);
});

test('the current batch follows the phase the request is working through', () => {
  const context = 'native_bd298de5-f544-449d-8ba3-76a7c77713f1_context_aaaaaaaa';
  const standard = 'native_bd298de5-f544-449d-8ba3-76a7c77713f1_standard_bbbbbbbb';
  assert.equal(currentBatchId({ phase: 'context_preparing', contextBatchId: context, standardBatchId: standard }), context);
  assert.equal(currentBatchId({ phase: 'standard_scoring', contextBatchId: context, standardBatchId: standard }), standard);
  // The context phase falls back to the only batch that exists yet.
  assert.equal(currentBatchId({ phase: 'context_preparing', contextBatchId: null, standardBatchId: standard }), standard);
});
