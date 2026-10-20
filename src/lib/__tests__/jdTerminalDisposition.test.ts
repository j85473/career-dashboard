import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyTerminalJdFailure,
  isTerminalJdFailure,
  summarizeTerminalJdFailures,
} from '../jdTerminalDisposition';

const terminal = (overrides: Partial<Parameters<typeof classifyTerminalJdFailure>[0]> = {}) => ({
  scoringStatus: 'failed',
  scoreError: 'JD recovery rejected: expired, closed, login, cookie, or portal shell.',
  passReason: null,
  description: 'Sign in to apply. Search jobs. Create an account.',
  ...overrides,
});

test('only terminal JD failures are classified', () => {
  assert.equal(classifyTerminalJdFailure(terminal({ scoringStatus: 'scored' })), null);
  assert.equal(classifyTerminalJdFailure(terminal({
    scoringStatus: 'failed',
    scoreError: 'Aim Fit could not score this job: forbidden capability',
    passReason: null,
  })), null);
  assert.equal(isTerminalJdFailure(terminal()), true);
});

test('a legacy JD pass reason is terminal even without a stored scoreError', () => {
  const classification = classifyTerminalJdFailure(terminal({
    scoreError: null,
    passReason: 'Error calling Jina. Manual review required.',
    description: null,
  }));
  assert.equal(classification?.disposition, 'unproven');
  assert.equal(classification?.cause, 'legacy_transport_failure');
  assert.equal(classification?.retryable, true);
});

test('a spent recovery series against a shell does not prove the job unavailable', () => {
  const classification = classifyTerminalJdFailure(terminal());
  assert.equal(classification?.disposition, 'unproven');
  assert.equal(classification?.retryable, true);
});

test('stale rejection labels do not replace the current saved-text assessment', () => {
  for (const scoreError of [
    'JD recovery rejected: no usable role duties.',
    'JD recovery rejected: no usable qualifications.',
    'JD recovery rejected: visibly truncated description.',
  ]) {
    const classification = classifyTerminalJdFailure(terminal({ scoreError, description: 'Manage customer accounts in the Midwest.' }));
    assert.equal(classification?.disposition, 'presently_recoverable', scoreError);
    assert.equal(classification?.cause, 'below_length_floor');
    assert.equal(classification?.retryable, true);
  }
});

test('a short but real description is recoverable rather than proven gone', () => {
  const classification = classifyTerminalJdFailure(terminal({
    scoreError: 'JD recovery rejected: description too short.',
    description: 'Sell things to people in the upper midwest.',
  }));
  assert.equal(classification?.disposition, 'presently_recoverable');
  assert.equal(classification?.cause, 'below_length_floor');
});

test('an empty description is never classified as proven unavailable', () => {
  // The whole point of the detail-fetch resolvers is that an empty body means
  // nothing was fetched yet. Calling that "gone" would dismiss the postings
  // those resolvers exist to recover.
  const classification = classifyTerminalJdFailure(terminal({
    scoreError: 'JD recovery rejected: description too short.',
    description: '',
  }));
  assert.equal(classification?.disposition, 'unproven');
  assert.equal(classification?.retryable, true);
});

test('the summary counts every bucket and cause', () => {
  const summary = summarizeTerminalJdFailures([
    terminal(),
    terminal(),
    terminal({ scoreError: 'JD recovery rejected: no usable role duties.', description: 'Manage customer accounts in the Midwest.' }),
    terminal({ scoringStatus: 'scored' }),
  ]);
  assert.equal(summary.proven_unavailable.jobs, 0);
  assert.deepEqual(summary.unproven.causes, { blocked_or_unusable_page: 2 });
  assert.equal(summary.presently_recoverable.jobs, 1);
  assert.equal(summary.unproven.jobs, 2);
});

test('classification never proposes a lifecycle change', () => {
  const classification = classifyTerminalJdFailure(terminal());
  assert.deepEqual(Object.keys(classification || {}).sort(), [
    'cause', 'disposition', 'rationale', 'retryable',
  ]);
});
