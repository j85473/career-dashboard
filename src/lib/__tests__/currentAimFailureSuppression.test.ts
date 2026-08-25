import assert from 'node:assert/strict';
import test from 'node:test';

import { currentAimFailureIdentity } from '../aimCurrentInput';
import { aimFailureKeys } from '../aimScoringFailure';
import { currentAimFailureSuppressions } from '../currentAimFailureSuppression';
import { currentScoringInputVersions } from '../scoringInputVersions';

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Partner Manager',
  company: 'Example Company',
  location: 'Chicago, IL',
  description: 'Build and enable a national partner ecosystem.',
  status: 'pending_af',
};

test('current Aim failure identity changes with material job and scoring inputs', () => {
  const versions = currentScoringInputVersions();
  const current = currentAimFailureIdentity(job, versions);

  assert.notEqual(
    currentAimFailureIdentity({ ...job, description: `${job.description} New responsibility.` }, versions).inputHash,
    current.inputHash,
  );
  assert.notEqual(
    currentAimFailureIdentity({ ...job, title: 'Senior Partner Manager' }, versions).inputHash,
    current.inputHash,
  );
  assert.notEqual(
    currentAimFailureIdentity(job, { ...versions, aimPolicyHash: 'a'.repeat(64) }).inputHash,
    current.inputHash,
  );
  assert.notEqual(
    currentAimFailureIdentity(job, { ...versions, runnerProtocolHash: 'b'.repeat(64) }).inputHash,
    current.inputHash,
  );
});

test('current suppression resolver retains stale receipts as history but returns only exact identities', async () => {
  const versions = currentScoringInputVersions();
  const identity = currentAimFailureIdentity(job, versions);
  const keys = aimFailureKeys({ ...identity, jobId: job.id, code: 'worker_invocation_failed' });
  const exact = {
    id: 'exact',
    jobId: job.id,
    inputHash: identity.inputHash,
    extractionIdentity: identity.extractionIdentity,
    runnerProtocolHash: identity.runnerProtocolHash,
    failureCode: 'worker_invocation_failed',
    retrySeriesKey: keys.retrySeriesKey,
    suppressionKey: keys.suppressionKey,
    suppressionActive: true,
    clearedAt: null,
    createdAt: new Date('2026-08-24T12:00:00Z'),
    job,
  };
  const stale = {
    ...exact,
    id: 'stale',
    inputHash: 'f'.repeat(64),
    createdAt: new Date('2026-08-24T11:00:00Z'),
  };
  const client = {
    aimScoringFailureReceipt: {
      findMany: async () => [exact, stale],
    },
  };

  const resolved = await currentAimFailureSuppressions(client as never);
  assert.deepEqual(resolved.map((receipt) => receipt.id), ['exact']);
  assert.equal(stale.suppressionActive, true);
  assert.equal(stale.clearedAt, null);
});

test('an affected-job invariant lookup scopes current receipt identity work once', async () => {
  const received: unknown[] = [];
  const client = {
    aimScoringFailureReceipt: {
      findMany: async (args: unknown) => {
        received.push(args);
        return [];
      },
    },
  };
  const ids = [job.id, '22222222-2222-4222-8222-222222222222', job.id];
  const resolved = await currentAimFailureSuppressions(client as never, ids);
  assert.deepEqual(resolved, []);
  assert.equal(received.length, 1);
  assert.deepEqual((received[0] as { where: { jobId: unknown } }).where.jobId, {
    in: [job.id, '22222222-2222-4222-8222-222222222222'],
  });
});
