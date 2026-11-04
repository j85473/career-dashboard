import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atsEmployerRetryCapacityJobs,
  createAtsEmployerRetryClaimer,
  isAtsEmployerVerificationHold,
  type AtsEmployerRetryMode,
} from '../../src/lib/atsEmployerRetry';

test('only explicit retained employer-evidence deferrals use recovery capacity', () => {
  for (const platform of ['oracle', 'ukg', 'successfactors', 'zohorecruit']) {
    assert.equal(isAtsEmployerVerificationHold(`${platform} downloaded work awaits a verified employer`), true);
  }
  assert.equal(isAtsEmployerVerificationHold('successfactors downloaded work awaits a verified posting location'), true);
  for (const reason of [null, '', 'Pipeline quiescence requested by deployment.', 'HTTP 429',
    'oracle employer request timed out', 'oracle downloaded work awaits a verified employer | HTTP 500']) {
    assert.equal(isAtsEmployerVerificationHold(reason), false);
  }
});

test('the recovery reservation leaves room below configured resume and pause limits', () => {
  assert.equal(atsEmployerRetryCapacityJobs(1_000, 2_000), 100);
  assert.equal(atsEmployerRetryCapacityJobs(50, 100), 12);
  assert.equal(atsEmployerRetryCapacityJobs(1_000, 100), 24);
  assert.equal(atsEmployerRetryCapacityJobs(0, 100), 0);
});

test('ordinary work advances between recovery turns even after every retry becomes due', async () => {
  let millis = Date.parse('2026-11-04T17:00:00Z');
  const modes: AtsEmployerRetryMode[] = [];
  const claim = createAtsEmployerRetryClaimer(async (_now, mode) => {
    modes.push(mode);
    return { employerVerificationRetry: mode === 'prefer' };
  }, () => new Date(millis));
  assert.equal((await claim())!.employerVerificationRetry, true);
  // A slow first recovery does not earn an immediate second recovery claim.
  millis += 120_000;
  for (let turn = 0; turn < 4; turn++) {
    assert.equal((await claim())!.employerVerificationRetry, false);
  }
  assert.equal((await claim())!.employerVerificationRetry, true);
  assert.deepEqual(modes, ['prefer', 'fallback', 'fallback', 'fallback', 'fallback', 'prefer']);
  for (let turn = 0; turn < 10; turn++) await claim();
  assert.ok(modes.slice(6).every(mode => mode === 'exclude'));
  millis += 60_000;
  assert.equal((await claim())!.employerVerificationRetry, true);
});

test('idle capacity continues recovery without requiring ordinary work to exist', async () => {
  let millis = Date.parse('2026-11-04T17:00:00Z');
  const claim = createAtsEmployerRetryClaimer(async (_now, mode) => (
    mode === 'exclude' ? null : { employerVerificationRetry: true }
  ), () => new Date(millis));
  assert.ok(await claim());
  assert.equal(await claim(), null);
  millis += 60_000;
  assert.ok(await claim());
});

test('candidate loading time cannot spend the next recovery allowance', async () => {
  let millis = Date.parse('2026-11-04T17:00:00Z');
  const modes: AtsEmployerRetryMode[] = [];
  const claim = createAtsEmployerRetryClaimer(async (_now, mode) => {
    modes.push(mode);
    millis += 70_000;
    return mode === 'exclude' ? null : { employerVerificationRetry: true };
  }, () => new Date(millis));
  await claim();
  await claim();
  assert.deepEqual(modes, ['prefer', 'exclude']);
});
