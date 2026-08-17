import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClosedPostingUpdate,
  describeJdFailureCause,
  buildTerminalJdRecoveryUpdate,
  decideJdRecovery,
  JD_RECOVERY_MANUAL_REVIEW_REASON,
  MAX_JD_RECOVERY_ATTEMPTS,
  planJdRecoveryReconciliation,
} from '../jdRecoveryPolicy';

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

test('a complete posting with Sharpsmart-style role wording is not mistaken for missing duties', () => {
  const description = [
    'Sharpsmart provides safety systems and medical waste collection for hospitals and healthcare customers.',
    'We are currently recruiting for a Plant Operative position; this role is critical to the success of the company with widely varying work, including:',
    'Checking in containers and checking the accompanying paperwork.',
    'Moving and unloading specific waste containers throughout the plant.',
    'Operating a forklift to load, unload, and organize containers safely.',
    'Emptying, washing, and inspecting reusable containers before dispatch.',
    'Supporting colleagues to maintain a clean, safe, and efficient working environment.',
    'What we are looking for',
    'Previous experience in a plant, warehouse, or similarly safety-focused environment.',
    'A valid forklift licence is preferred, along with the ability to follow documented procedures.',
    'The ability to work a four-on, four-off shift pattern and communicate clearly with colleagues is required.',
  ].join('\n');

  assert.ok(description.length >= 650);
  assert.equal(decideJdRecovery(description, 0).kind, 'ready');
});

test('structured ATS postings do not require English headings to prove their provenance twice', () => {
  const structuredPosting = [
    'Notre entreprise conçoit et fabrique des solutions techniques pour des clients internationaux.',
    'Vous organiserez les activités quotidiennes de l’équipe, suivrez les projets et accompagnerez les clients.',
    'Vous préparerez les dossiers, coordonnerez les partenaires et assurerez le respect des procédures internes.',
    'Une expérience professionnelle pertinente, une excellente communication et une grande autonomie sont attendues.',
  ].join(' ').repeat(3);

  assert.equal(decideJdRecovery(structuredPosting, 0).kind, 'retry');
  assert.equal(decideJdRecovery(structuredPosting, 0, { structuredSource: true }).kind, 'ready');
});

test('structured provenance never admits terminal or cookie-shell content', () => {
  const shell = 'Cookie preferences. Sign in to apply. Search jobs. '.repeat(30);
  const decision = decideJdRecovery(shell, 0, { structuredSource: true });
  assert.equal(decision.kind, 'retry');
  if (decision.kind === 'retry') assert.match(decision.reason, /portal shell|cookie/i);
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

test('a confirmed closed posting is a dismissal rather than a JD failure', () => {
  assert.deepEqual(decideJdRecovery('This job is no longer available.', 2), {
    kind: 'closed',
    text: 'This job is no longer available.',
  });
  assert.deepEqual(buildClosedPostingUpdate(), {
    status: 'dismissed',
    scoringStatus: 'skipped',
    scoreAttempts: 0,
    scoreError: null,
    passReason: 'Job posting is closed.',
    jdBatchId: null,
    batchJobId: null,
  });
});

test('terminal JD recovery remains active for Action Needed instead of dismissing the job', () => {
  const update = buildTerminalJdRecoveryUpdate('JD recovery returned no usable text.');

  assert.deepEqual(update, {
    scoreAttempts: MAX_JD_RECOVERY_ATTEMPTS,
    scoringStatus: 'failed',
    scoreError: 'JD recovery returned no usable text.',
    passReason: JD_RECOVERY_MANUAL_REVIEW_REASON,
  });
  assert.equal('status' in update, false);
});

test('terminal false-rejection reconciliation preserves the local-before-Aim pipeline', () => {
  assert.equal(planJdRecoveryReconciliation({
    source: 'ATS-lever',
    description: completeJobDescription,
  }).action, 'queue_local');

  assert.equal(planJdRecoveryReconciliation({
    source: 'ATS-workday',
    description: '',
  }).action, 'retry_extraction');

  assert.equal(planJdRecoveryReconciliation({
    source: 'Adzuna',
    description: 'Short provider snippet.',
  }).action, 'retry_extraction');

  assert.equal(planJdRecoveryReconciliation({
    source: 'ATS-lever',
    description: 'The position has been filled.',
  }).action, 'dismiss_closed');
});

test('a dead page is dismissed on reconciliation but still gets its bounded retry series first', () => {
  // A real row from Action Needed: the page loaded, but all that came back was
  // the cookie banner. 130 of these were queued asking a human to repair a page
  // that no longer exists.
  const cookieShell = [
    'Cookie Preferences',
    'We use cookies to personalise content and to analyse our traffic.',
    'Accept all cookies or manage cookies to choose which categories you allow.',
    'Privacy Preference Center',
  ].join('\n');

  // Inline recovery still spends its attempts — a cookie wall can let a later
  // fetch through, so the first pass must not give up on it.
  const firstPass = decideJdRecovery(cookieShell, 0);
  assert.equal(firstPass.kind, 'retry');
  if (firstPass.kind === 'retry') assert.equal(firstPass.terminal, false);

  // Once it is already terminal, reconciliation dismisses rather than requeues.
  assert.equal(planJdRecoveryReconciliation({
    source: 'ATS-greenhouse',
    description: cookieShell,
  }).action, 'dismiss_closed');
});

test('an empty description is a gap on our side, never a dead posting', () => {
  // looksLikeInvalidJobDescription('') is true, so a rule keyed only on the
  // quality reason would dismiss every job whose body we simply never fetched —
  // exactly the SmartRecruiters/Workable/BambooHR rows the detail calls rescue.
  for (const description of ['', '   ', null, undefined]) {
    assert.equal(planJdRecoveryReconciliation({
      source: 'ATS-smartrecruiters',
      description,
    }).action, 'retry_extraction');
  }
});

test('the operator summary separates an unfetched body from a dead page', () => {
  const shell = { scorable: false, reason: 'expired, closed, login, cookie, or portal shell' };
  // Identical quality verdict, opposite causes and opposite responses.
  assert.equal(describeJdFailureCause('', shell), 'no description ever fetched');
  assert.equal(describeJdFailureCause('   ', shell), 'no description ever fetched');
  assert.match(describeJdFailureCause('Cookie Preferences page text', shell), /^dead page/);
  assert.equal(
    describeJdFailureCause('Some short text', { scorable: false, reason: 'fewer than 650 usable characters' }),
    'fewer than 650 usable characters',
  );
});
