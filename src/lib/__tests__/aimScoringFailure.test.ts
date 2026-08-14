import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeAimFailureSuppression,
  aimFailureKeys,
  aimFailurePermanence,
  normalizeAimFailureDetail,
  recordAimFailureReceipt,
} from '../aimScoringFailure';

const base = {
  jobId: '11111111-1111-4111-8111-111111111111',
  inputHash: 'a'.repeat(64),
  extractionIdentity: 'b'.repeat(64),
  runnerProtocolHash: 'c'.repeat(64),
  scoringPolicyHash: 'd'.repeat(64),
  resultBuilderSemanticVersion: 'aim-result-builder-v2',
} as const;

test('Aim failure identity separates extraction and builder resolution', () => {
  const extraction = aimFailureKeys({ ...base, code: 'evidence_invalid' });
  const builder = aimFailureKeys({ ...base, code: 'extraction_identity_vector_conflict' });
  assert.equal(aimFailurePermanence('evidence_invalid'), 'transient');
  assert.equal(aimFailurePermanence('model_context_limit_exceeded'), 'input_bound');
  assert.notEqual(extraction.failureResolutionIdentity, builder.failureResolutionIdentity);
  assert.notEqual(extraction.retrySeriesKey, builder.retrySeriesKey);
});

test('active suppression is exact-identity bound and cleared receipts are inactive', () => {
  const keys = aimFailureKeys({ ...base, code: 'model_context_limit_exceeded' });
  const receipt = {
    jobId: base.jobId,
    inputHash: base.inputHash,
    extractionIdentity: base.extractionIdentity,
    runnerProtocolHash: base.runnerProtocolHash,
    failureCode: 'model_context_limit_exceeded',
    retrySeriesKey: keys.retrySeriesKey,
    suppressionKey: keys.suppressionKey,
    suppressionActive: true,
    clearedAt: null,
  } as const;
  assert.equal(activeAimFailureSuppression(receipt, base), true);
  assert.equal(activeAimFailureSuppression({ ...receipt, clearedAt: new Date() }, base), false);
  assert.equal(activeAimFailureSuppression(receipt, { ...base, inputHash: 'e'.repeat(64) }), false);
});

test('failure details reject raw source and internal control leakage without identity detection', () => {
  assert.equal(normalizeAimFailureDetail('  bounded worker invocation failed  '), 'bounded worker invocation failed');
  assert.equal(normalizeAimFailureDetail('Joseph was present'), 'Joseph was present');
  for (const detail of ['raw JD follows', 'approval token leaked']) {
    assert.throws(() => normalizeAimFailureDetail(detail), /private or internal material/);
  }
});

test('transient failures activate suppression on the third immutable series receipt', async () => {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    aimScoringFailureReceipt: {
      findMany: async () => created.length ? [{ seriesOrdinal: created.length }] : [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
  };
  for (let index = 0; index < 3; index += 1) {
    await recordAimFailureReceipt({
      ...base,
      tx: tx as never,
      producedByBatchItemId: `item-${index}`,
      sourceIdentity: 'f'.repeat(64),
      protocolVersion: 'career-dashboard-scoring-protocol-v2',
      code: 'worker_invocation_failed',
      phase: 'stage1',
      packetOrdinal: 0,
      attempts: 1,
      detail: 'bounded worker invocation failed',
    });
  }
  assert.deepEqual(created.map((entry) => entry.suppressionActive), [false, false, true]);
  assert.deepEqual(created.map((entry) => entry.seriesOrdinal), [1, 2, 3]);
});
