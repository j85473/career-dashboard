import assert from 'node:assert/strict';
import test from 'node:test';

import { decideJdRecovery } from '../jdRecoveryPolicy';

const completeJobDescription = [
  'About the role',
  'This position owns a multi-state channel territory and works directly with established distributor partners.',
  'Responsibilities',
  'Manage assigned channel partner accounts and grow territory revenue.',
  'Build quarterly account plans and coordinate distributor enablement.',
  'Review partner performance, identify account-growth opportunities, and maintain executive relationships.',
  'Required Qualifications',
  'At least 3 years of channel sales or account management experience.',
  'Demonstrated experience building business plans with distributors or reseller partners.',
  'Proficiency with CRM reporting and territory analysis is required.',
  'The role partners with sales leadership to deliver measurable account retention and expansion results.',
].join('\n');

test('complete recovered JDs are admitted without consuming another retry', () => {
  const decision = decideJdRecovery(completeJobDescription, 2);
  assert.equal(decision.kind, 'ready');
  if (decision.kind === 'ready') assert.equal(decision.text, completeJobDescription);
});

test('long portal and cookie pages cannot masquerade as successful JD recovery', () => {
  const portal = 'Cookie preferences. Sign in to apply. Search jobs. '.repeat(30);
  const decision = decideJdRecovery(portal, 0);

  assert.equal(decision.kind, 'retry');
  if (decision.kind === 'retry') {
    assert.equal(decision.nextAttempts, 1);
    assert.equal(decision.terminal, false);
    assert.match(decision.reason, /portal shell|cookie/i);
  }
});

test('short snippets and pages without qualifications remain fail closed', () => {
  const snippet = 'Manage assigned customers and partner relationships.';
  const noQualifications = [
    'Responsibilities',
    'Manage assigned channel partner accounts and grow territory revenue.',
    'Build quarterly account plans and coordinate distributor enablement.',
  ].join('\n').repeat(8);

  const shortDecision = decideJdRecovery(snippet, 0);
  const incompleteDecision = decideJdRecovery(noQualifications, 1);
  assert.equal(shortDecision.kind, 'retry');
  assert.equal(incompleteDecision.kind, 'retry');
  if (incompleteDecision.kind === 'retry') {
    assert.equal(incompleteDecision.nextAttempts, 2);
    assert.match(incompleteDecision.reason, /qualifications/i);
  }
});

test('the third failed recovery is terminal instead of resetting into a loop', () => {
  const decision = decideJdRecovery('Title: Custom Job Error URL', 2);
  assert.equal(decision.kind, 'retry');
  if (decision.kind === 'retry') {
    assert.equal(decision.nextAttempts, 3);
    assert.equal(decision.terminal, true);
  }
});
