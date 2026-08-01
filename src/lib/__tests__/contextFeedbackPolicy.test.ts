import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextDecisionAlreadyHandled,
  contextRulesForNativeScoring,
  isContextFeedbackEligible,
  negativeOnlyContextRules,
} from '../contextFeedbackPolicy';

test('only intentional passed-job feedback enters the context queue', () => {
  assert.equal(isContextFeedbackEligible('passed', 'Experience mismatch'), true);
  assert.equal(isContextFeedbackEligible('passed', 'Location mismatch'), true);
  assert.equal(isContextFeedbackEligible('passed', 'Expired'), false);
  assert.equal(isContextFeedbackEligible('applied', 'Great fit'), false);
  assert.equal(isContextFeedbackEligible('interviewing', 'Great fit'), false);
  assert.equal(isContextFeedbackEligible('passed', ''), false);
});

test('legacy mixed profiles are reduced to their negative rules for native scoring', () => {
  assert.equal(
    contextRulesForNativeScoring([
      '- DO REJECT Inside sales',
      '- POSITIVE: SaaS',
      '- Reject: staffing-company roles',
      '- Negative: cold-calling-first roles',
      '- DO REJECT Expired roles',
    ].join('\n')),
    'DO REJECT:\n- Inside sales\n- staffing-company roles\n- cold-calling-first roles',
  );
  assert.equal(
    contextRulesForNativeScoring('DO REJECT:\n- Inside sales'),
    'DO REJECT:\n- Inside sales',
  );
  assert.equal(
    contextRulesForNativeScoring([
      'DO REJECT:',
      '- Inside sales',
      'DO ACCEPT:',
      '- High-travel field sales',
      'POSITIVE:',
      '- Strategic accounts',
    ].join('\n')),
    'DO REJECT:\n- Inside sales',
  );
  assert.equal(
    contextRulesForNativeScoring(null),
    'DO REJECT:\n- No established negative preference rules.',
  );
});

test('applied and non-preference decisions are marked handled for context', () => {
  assert.equal(contextDecisionAlreadyHandled('applied', null), true);
  assert.equal(contextDecisionAlreadyHandled('interviewing', null), true);
  assert.equal(contextDecisionAlreadyHandled('passed', 'Expired'), true);
  assert.equal(contextDecisionAlreadyHandled('passed', 'Too much hunting'), false);
});

test('native context output is constrained to a negative-only profile', () => {
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- Inside sales'), true);
  assert.equal(negativeOnlyContextRules('DO ACCEPT:\n- SaaS\nDO REJECT:\n- Retail'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- positive_applied roles'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- POSITIVE: SaaS roles'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- Expired roles'), false);
});
