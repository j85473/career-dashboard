import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pairKey,
  passJudgesJob,
  planSameJobConsolidation,
  type SameJobCard,
} from '../sameJobConsolidation';

function words(seed: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${seed}${(index * 7919) % 1009}`).join(' ');
}

const JD = words('duty', 280);
const BOILERPLATE = words('about', 150);

let created = 0;
function card(id: string, overrides: Partial<SameJobCard> = {}): SameJobCard {
  created += 1;
  return {
    id, title: 'Account Manager', company: 'Acme', location: 'Minneapolis, MN', description: JD,
    source: 'Himalayas', status: 'inbox', passReason: null, createdAt: new Date(Date.UTC(2026, 8, 1, 0, created)),
    aimFitScore: 80, reqFitScore: 80, userOwned: false, inFlight: false, hasSubmittedResume: false,
    tailoringStaged: false, ...overrides,
  };
}

function folds(cards: SameJobCard[], exceptions = new Set<string>()) {
  return planSameJobConsolidation(cards, exceptions);
}

test('a machine copy folds into the card Joseph acted on', () => {
  for (const status of ['applied', 'interviewing', 'bookmarked', 'passed']) {
    const plan = folds([
      card('copy', { status: 'inbox', source: 'LinkedIn (Apify)', aimFitScore: 95, reqFitScore: 95 }),
      card('mine', { status, source: 'ATS-greenhouse', userOwned: true, aimFitScore: null, reqFitScore: null }),
    ]);
    assert.deepEqual(plan.folds.map((fold) => [fold.redundantId, fold.survivorId]), [['copy', 'mine']], status);
  }
});

test('a card Joseph acted on is never folded, even into another of his cards', () => {
  const plan = folds([
    card('applied', { status: 'applied', userOwned: true }),
    card('promoted', { status: 'inbox', userOwned: true, source: 'ATS-lever' }),
  ]);
  assert.deepEqual(plan, { folds: [], deferred: [], held: [] });
});

test('among machine copies the scored card survives, so no score moves', () => {
  const plan = folds([
    card('unscored-ats', { status: 'pending_af', source: 'ATS-workday', aimFitScore: null, reqFitScore: null }),
    card('scored-copy', { status: 'inbox', source: 'LinkedIn (Apify)' }),
  ]);
  assert.deepEqual(plan.folds.map((fold) => fold.survivorId), ['scored-copy']);
});

test('Cooldown outranks Inbox, and the employer posting breaks a tie', () => {
  const cooldown = folds([
    card('inbox-copy', { status: 'inbox', source: 'LinkedIn (Apify)', company: 'Arctic Wolf' }),
    card('cooldown', { status: 'cooldown', source: 'ATS-workday', company: 'Arctic Wolf Networks, Inc.' }),
  ]);
  assert.deepEqual(cooldown.folds.map((fold) => fold.survivorId), ['cooldown']);
  const tie = folds([
    card('reprint', { source: 'Himalayas' }),
    card('employer', { source: 'ATS-greenhouse' }),
  ]);
  assert.deepEqual(tie.folds.map((fold) => fold.survivorId), ['employer']);
});

test('a copy that could belong to two requisitions is left alone', () => {
  // HP posted four "Account Executive" requisitions; each CareerForce copy matched all of them.
  const plan = folds([
    card('req-1', { source: 'ATS-workday', status: 'cooldown' }),
    card('req-2', { source: 'ATS-workday', status: 'cooldown' }),
    card('copy', { source: 'careerforce', status: 'cooldown' }),
  ]);
  assert.deepEqual(plan.folds, []);
  assert.equal(plan.held[0].reason, 'ambiguous');
});

test('copies linked only through a survivor that names their city fold together', () => {
  // Scotts: "Minnesota, US" and "Minneapolis, Hennepin County" cannot be
  // compared directly, but both match the applied Minneapolis card.
  const cards = [
    card('applied', { status: 'applied', userOwned: true, source: 'ATS-workday', title: 'Sales Manager - Minneapolis, MN', location: 'Minneapolis, MN' }),
    card('state', { source: 'Adzuna', title: 'Sales Manager - Minneapolis, MN', location: 'Minnesota, US' }),
    card('county', { source: 'Adzuna', title: 'Sales Manager - Minneapolis, MN', location: 'Minneapolis, Hennepin County' }),
  ];
  assert.deepEqual(folds(cards).folds.map((fold) => fold.redundantId).sort(), ['county', 'state']);
  // A national survivor anchors nothing: two different cities stay unresolved.
  const national = folds([
    card('national', { status: 'applied', userOwned: true, location: 'United States' }),
    card('minneapolis', { source: 'LinkedIn (Apify)', location: 'Minneapolis, MN' }),
    card('chicago', { source: 'Adzuna', location: 'Chicago, IL' }),
  ]);
  assert.deepEqual(national.folds, []);
  assert.equal(national.held[0].reason, 'ambiguous');
});

test('"Not the same job" is honored for that pair', () => {
  const cards = [card('a', { source: 'LinkedIn (Apify)' }), card('b', { source: 'ATS-lever' })];
  assert.equal(folds(cards).folds.length, 1);
  assert.deepEqual(folds(cards, new Set([pairKey('b', 'a')])).folds, []);
});

test('a card held by an export waits for the next pass', () => {
  const plan = folds([card('a', { inFlight: true }), card('b', { source: 'ATS-lever' })]);
  assert.deepEqual(plan.folds, []);
  assert.equal(plan.deferred.length, 1);
});

test('different requisitions are never grouped', () => {
  const plan = folds([
    card('a', { description: `${BOILERPLATE} ${words('reqa', 130)}` }),
    card('b', { source: 'ATS-greenhouse', description: `${BOILERPLATE} ${words('reqb', 130)}` }),
  ]);
  assert.deepEqual(plan, { folds: [], deferred: [], held: [] });
});

test('only a pass that judges the job can absorb a copy', () => {
  for (const reason of ['Not interested', 'Location mismatch', 'Experience mismatch', 'Already applied', 'pay too low', '', null]) {
    assert.equal(passJudgesJob(reason), true, String(reason));
  }
  for (const reason of ['Expired', 'Auto-dismissed retail/B2C role', '[Local Triage] Fit score too low.', 'International location rejected', 'Location rejected (Austin, Texas, United States)', 'Promoted by user: Manually promoted by user']) {
    assert.equal(passJudgesJob(reason), false, reason);
  }
});
