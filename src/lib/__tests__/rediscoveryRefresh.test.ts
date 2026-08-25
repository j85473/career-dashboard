import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  decideRediscoveryRefresh,
  rediscoveryRefreshUpdate,
  REDISCOVERY_REFRESH_REASON,
  type RediscoveryRefreshCandidate,
} from '../rediscoveryRefresh';

const SCORABLE_JD = [
  'About the role',
  'You will own a book of enterprise accounts across the upper midwest and grow renewals.',
  'Responsibilities include running quarterly business reviews, building account plans,',
  'coordinating with solution engineering, forecasting accurately in the CRM, and',
  'partnering with customer success on adoption milestones across the installed base.',
  'Qualifications',
  'Five years of quota-carrying enterprise sales experience, demonstrated success renewing',
  'and expanding six-figure contracts, experience selling technical products to operations',
  'buyers, strong written communication, and a track record of accurate forecasting.',
  'We offer competitive compensation, equity, and comprehensive benefits for this position.',
].join('\n');

const UNUSABLE_JD = 'Please sign in to view this job posting.';

function candidate(overrides: Partial<RediscoveryRefreshCandidate> = {}): RediscoveryRefreshCandidate {
  return {
    status: 'pending_af',
    scoringStatus: 'failed',
    source: 'ATS-greenhouse',
    description: UNUSABLE_JD,
    tailoringStaged: false,
    aimFitScore: null,
    reqFitScore: null,
    batchJobId: null,
    jdBatchId: null,
    afBatchId: null,
    userLifecycleEventCount: 0,
    leasedScoringItemCount: 0,
    ...overrides,
  };
}

test('a provider that finally serves a usable description refreshes the stuck posting', () => {
  const decision = decideRediscoveryRefresh(candidate(), SCORABLE_JD);
  assert.equal(decision.refresh, true);
  if (!decision.refresh) return;
  assert.equal(decision.reason, REDISCOVERY_REFRESH_REASON);
  assert.ok(decision.incomingLength > decision.storedLength);
});

test('the refresh only ever returns a job to scoring', () => {
  const update = rediscoveryRefreshUpdate(SCORABLE_JD);
  assert.equal(update.scoringStatus, 'queued');
  assert.equal(update.scoreError, null);
  assert.equal(update.passReason, null);
  // Nothing here may touch lifecycle status or any score.
  for (const forbidden of ['status', 'aimFitScore', 'reqFitScore', 'tailoringStaged']) {
    assert.equal(forbidden in update, false, `${forbidden} must not be written by a JD refresh`);
  }
});

test('a job that already carries a score is never overwritten', () => {
  for (const scored of [{ aimFitScore: 72 }, { reqFitScore: 55 }]) {
    const decision = decideRediscoveryRefresh(candidate(scored), SCORABLE_JD);
    assert.equal(decision.refresh, false);
    assert.equal(decision.reason, 'job_already_carries_a_score');
  }
});

test('user decisions, staged tailoring, and Manual Import all veto the refresh', () => {
  assert.equal(
    decideRediscoveryRefresh(candidate({ userLifecycleEventCount: 1 }), SCORABLE_JD).reason,
    'explicit_user_event_veto',
  );
  assert.equal(
    decideRediscoveryRefresh(candidate({ tailoringStaged: true }), SCORABLE_JD).reason,
    'tailoring_staged',
  );
  assert.equal(
    decideRediscoveryRefresh(candidate({ source: 'Manual Import' }), SCORABLE_JD).reason,
    'manual_import_protected',
  );
});

test('work in flight blocks the refresh', () => {
  for (const inflight of [
    { leasedScoringItemCount: 1 },
    { batchJobId: 'lease-1' },
    { jdBatchId: 'jd-1' },
    { afBatchId: 'af-1' },
  ]) {
    assert.equal(
      decideRediscoveryRefresh(candidate(inflight), SCORABLE_JD).reason,
      'active_or_ambiguous_lease',
    );
  }
  assert.equal(
    decideRediscoveryRefresh(candidate({ scoringStatus: 'scoring' }), SCORABLE_JD).reason,
    'scoring_in_flight',
  );
});

test('a terminal or protected lifecycle state is left alone', () => {
  for (const status of ['dismissed', 'applied', 'expired', 'passed', 'bookmarked', 'cooldown']) {
    assert.equal(
      decideRediscoveryRefresh(candidate({ status }), SCORABLE_JD).reason,
      'job_is_not_active',
      status,
    );
  }
});

test('a already-good stored description is never replaced', () => {
  const decision = decideRediscoveryRefresh(
    candidate({ description: SCORABLE_JD }),
    `${SCORABLE_JD}\nExtra trailing content that makes this longer.`,
  );
  assert.equal(decision.refresh, false);
  assert.equal(decision.reason, 'stored_description_is_already_scorable');
});

test('an unusable or shorter incoming description changes nothing', () => {
  assert.equal(
    decideRediscoveryRefresh(candidate(), 'Sign in to continue.').refresh,
    false,
  );
  assert.equal(
    decideRediscoveryRefresh(candidate({ description: SCORABLE_JD.slice(0, 400) }), 'short').reason,
    'incoming_description_is_not_scorable',
  );
});

test('ingestion refreshes under an exact-state guard and never on a closed posting', () => {
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const branchStart = ingestion.indexOf('const refreshCandidate = await prisma.job.findUnique');
  assert.ok(branchStart > 0, 'the rediscovery refresh branch is missing from ingestion');
  const branch = ingestion.slice(
    branchStart,
    ingestion.indexOf("details: { reason: 'source_observation' }", branchStart),
  );
  assert.match(branch, /if \(refreshed\.count === 1\)/);
  assert.match(branch, /aimFitScore: null/);
  assert.match(branch, /reqFitScore: null/);
  assert.match(branch, /tailoringStaged: false/);
  assert.match(branch, /nonManualImportSourceWhere\(\)/);
  assert.match(ingestion, /if \(!postingClosed\) \{\n\s+const refreshCandidate/);
});
