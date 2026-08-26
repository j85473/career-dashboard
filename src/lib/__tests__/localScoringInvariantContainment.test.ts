import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { JobLifecycleInvariantError } from '../jobLifecycleInvariant';
import { LOCAL_SCORING_TERMINAL_ATTEMPTS } from '../localScoringPolicy';
import { localInvariantQuarantineData } from '../jobScoring';
import { isRawLocalTerminalFailure } from '../operationalQueue';

test('local lifecycle invariant failures become bounded raw Action Needed failures', () => {
  const error = new JobLifecycleInvariantError([{
    jobId: 'job-1',
    invariant: 'pending_af_cannot_be_skipped',
    authorityEventId: 'event-1',
    proposedState: {
      status: 'pending_af', scoringStatus: 'skipped', tailoringStaged: false,
      aimFitScore: null, reqFitScore: null,
    },
  }]);
  const data = localInvariantQuarantineData(error, 0);
  assert.deepEqual(data, {
    scoringStatus: 'failed',
    batchJobId: null,
    scoreAttempts: LOCAL_SCORING_TERMINAL_ATTEMPTS,
    scoreError: 'Local scoring invariant blocked: pending_af_cannot_be_skipped',
  });
  assert.equal(isRawLocalTerminalFailure({
    scoringStatus: String(data.scoringStatus),
    scoreAttempts: Number(data.scoreAttempts),
    scoreError: String(data.scoreError),
  }), true);
  assert.doesNotMatch(String(data.scoreError), /description|responsibilit/i);
});

test('local scorer clears the exact lease, preserves lifecycle, and continues after containment', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/jobScoring.ts'), 'utf8');
  assert.match(source, /if \(error instanceof JobLifecycleInvariantError\) \{/);
  assert.match(source, /batchJobId: leaseId,[\s\S]*?scoringStatus: 'scoring'/);
  assert.match(source, /data: localInvariantQuarantineData/);
  assert.match(source, /if \(quarantined\.count === 0\) await releaseLocalScoringLease/);
  assert.match(source, /Action needed for[\s\S]*?continue;/);
  const release = source.slice(
    source.indexOf('async function releaseLocalScoringLease'),
    source.indexOf('export function localInvariantQuarantineData'),
  );
  assert.doesNotMatch(release, /assertJobLifecycleInvariants/);
});

test('a retryable transaction failure cannot strand its local-scoring lease', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/jobScoring.ts'), 'utf8');
  const failureCatch = source.slice(
    source.indexOf('} catch (failureWriteError: unknown) {'),
    source.indexOf('\n      }\n    }\n  }', source.indexOf('} catch (failureWriteError: unknown) {')),
  );
  assert.match(failureCatch, /isRetryableIngestionTransactionError/);
  assert.match(failureCatch, /const released = await prisma\.job\.updateMany/);
  assert.match(failureCatch, /where: leasedRow/);
  assert.match(failureCatch, /batchJobId: null/);
  assert.match(failureCatch, /if \(released\.count === 0\) await releaseLocalScoringLease/);
});
