import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAimLocalPolicy,
  evaluateAimStage1,
  isCurrentAimExperienceAnchor,
  normalizeDirectEmployerName,
} from '../aimStage1';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import type { AimFactualVector } from '../aimV2Types';

test('Aim local policy uses normalized direct-employer equality and zero model facts', () => {
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  assert.equal(normalizeDirectEmployerName('AT&T, Inc.'), 'at and t');
  assert.deepEqual(evaluateAimLocalPolicy({ company: 'PepsiCo, Inc.', title: 'Channel Manager', location: null }, policy), {
    triggerCodes: ['direct_pepsico_employer'], decision: 'killed_local_policy',
  });
  assert.deepEqual(evaluateAimLocalPolicy({ company: 'AT&T LLC', title: 'Partner Manager', location: null }, policy), {
    triggerCodes: ['direct_att_employer'], decision: 'killed_local_policy',
  });
  assert.deepEqual(evaluateAimLocalPolicy({ company: 'Agency serving PepsiCo', title: 'Account Manager', location: null }, policy), {
    triggerCodes: [], decision: 'continue_to_stage1',
  });
});

test('Aim Stage 1 question 3 dismisses only yes; no and unsupported pass', () => {
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  const metadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };
  const vector = (answer: 'yes' | 'no' | 'unsupported'): AimFactualVector => ({
    scope: 'stage1',
    answers: [{ questionId: 'S1.Q03', answer, evidenceIds: [] }],
    evidenceCatalog: [],
  } as unknown as AimFactualVector);

  assert.deepEqual(evaluateAimStage1(vector('yes'), metadata, policy), {
    triggerQuestionIds: ['S1.Q03'], locationState: 'incompatible', insuranceState: null,
    decision: 'killed_by_factual_screen',
  });
  for (const answer of ['no', 'unsupported'] as const) {
    assert.deepEqual(evaluateAimStage1(vector(answer), metadata, policy), {
      triggerQuestionIds: [], locationState: null, insuranceState: null,
      decision: 'continue_to_compensation',
    });
  }
});

test('only the current Stage 1 extraction anchors downstream Experience scoring', () => {
  const sourceJdHash = 'a'.repeat(64);
  assert.equal(isCurrentAimExperienceAnchor({ scope: 'stage1', sourceJdHash, staleAt: null }, sourceJdHash), true);
  assert.equal(isCurrentAimExperienceAnchor({ scope: 'complete', sourceJdHash, staleAt: null }, sourceJdHash), false);
  assert.equal(isCurrentAimExperienceAnchor({ scope: 'stage1', sourceJdHash, staleAt: new Date() }, sourceJdHash), false);
  assert.equal(isCurrentAimExperienceAnchor({ scope: 'stage1', sourceJdHash: 'b'.repeat(64), staleAt: null }, sourceJdHash), false);
  assert.equal(isCurrentAimExperienceAnchor(null, sourceJdHash), false);
});
