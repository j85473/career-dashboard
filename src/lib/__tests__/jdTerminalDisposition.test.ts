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
  description: 'A portal shell page with no posting content at all.',
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

test('a spent recovery series against a shell is proven unavailable and not retryable', () => {
  const classification = classifyTerminalJdFailure(terminal());
  assert.equal(classification?.disposition, 'proven_unavailable');
  assert.equal(classification?.retryable, false);
});

test('real posting text that misses the quality floor stays recoverable', () => {
  for (const [scoreError, cause] of [
    ['JD recovery rejected: no usable role duties.', 'no_usable_duties'],
    ['JD recovery rejected: no usable qualifications.', 'no_usable_qualifications'],
    ['JD recovery rejected: visibly truncated description.', 'truncated_description'],
  ] as const) {
    const classification = classifyTerminalJdFailure(terminal({ scoreError }));
    assert.equal(classification?.disposition, 'presently_recoverable', scoreError);
    assert.equal(classification?.cause, cause);
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
    terminal({ scoreError: 'JD recovery rejected: no usable role duties.' }),
    terminal({ scoringStatus: 'scored' }),
  ]);
  assert.equal(summary.proven_unavailable.jobs, 2);
  assert.deepEqual(summary.proven_unavailable.causes, { closed_or_portal_shell: 2 });
  assert.equal(summary.presently_recoverable.jobs, 1);
  assert.equal(summary.unproven.jobs, 0);
});

test('classification never proposes a lifecycle change', () => {
  const classification = classifyTerminalJdFailure(terminal());
  assert.deepEqual(Object.keys(classification || {}).sort(), [
    'cause', 'disposition', 'rationale', 'retryable',
  ]);
});
