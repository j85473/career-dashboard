import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextDecisionAlreadyHandled,
  contextRulesForNativeScoring,
  isContextFeedbackEligible,
  negativeOnlyContextRules,
  validateTypedContextRules,
} from '../contextFeedbackPolicy';

test('only intentional passed-job feedback enters the context queue', () => {
  assert.equal(isContextFeedbackEligible('passed', 'Experience mismatch'), false);
  assert.equal(isContextFeedbackEligible('passed', 'Location mismatch'), false);
  assert.equal(isContextFeedbackEligible('passed', 'Expired'), false);
  assert.equal(isContextFeedbackEligible('applied', 'Great fit'), false);
  assert.equal(isContextFeedbackEligible('interviewing', 'Great fit'), false);
  assert.equal(isContextFeedbackEligible('passed', ''), false);
  assert.equal(isContextFeedbackEligible('passed', 'Too much hunting'), true);
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
  assert.equal(contextDecisionAlreadyHandled('passed', 'Experience mismatch'), true);
  assert.equal(contextDecisionAlreadyHandled('passed', 'Location mismatch'), true);
  assert.equal(contextDecisionAlreadyHandled('passed', 'Too much hunting'), false);
});

test('legacy context calibration keeps preferences separate from qualifications', () => {
  assert.equal(
    contextRulesForNativeScoring([
      'DO REJECT:',
      '- roles that strongly require highly specific market, industry, technical, medical, or legal domain experience that the candidate does not explicitly possess.',
      '- roles requiring deep technical, code-literate, or SaaS infrastructure/architectural experience that the candidate does not possess.',
      '- general Customer Success Manager (CSM), Customer Training & Adoption Specialist, or Account Management roles not strictly focused on Channel Sales/Partner Enablement or outside preferred industries.',
      '- roles where prospecting is the primary duty.',
    ].join('\n')),
    [
      'DO REJECT:',
      '- post-sale roles dominated by support, training, implementation, or internal operations without commercial ownership, account growth, or strategic partner scope.',
      '- roles where prospecting is the primary duty.',
    ].join('\n'),
  );
});

test('native context output is constrained to a negative-only profile', () => {
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- Inside sales'), true);
  assert.equal(negativeOnlyContextRules('DO ACCEPT:\n- SaaS\nDO REJECT:\n- Retail'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- positive_applied roles'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- POSITIVE: SaaS roles'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- Expired roles'), false);
  assert.equal(negativeOnlyContextRules('DO REJECT:\n- Wireless technology roles'), false);
});

test('typed Context validation blocks qualification leakage and immutable target conflicts', () => {
  const result = validateTypedContextRules([
    'DO REJECT:',
    '- Inside sales roles',
    '- Wireless technology roles',
    '- High-travel field sales roles',
    '- Remote roles outside the Midwest',
    '- roles requiring deep technical, code-literate, or SaaS infrastructure/architectural experience that the candidate does not possess.',
  ].join('\n'));

  assert.deepEqual(result.accepted.map((rule) => rule.text), ['Inside sales roles']);
  assert.equal(result.accepted[0].dimension, 'role_function');
  assert.equal(result.accepted[0].scope, 'aim_only');
  assert.equal(result.accepted[0].source, 'legacy_rules_text');
  assert.equal(result.rejected.length, 4);
  assert.match(result.rejected.map((rule) => rule.reason).join(' '), /telecom|positive role|work base|Experience/i);
});

test('typed Context validation rejects immutable-target and qualification paraphrases exactly', () => {
  const conflicting = [
    'Roles in the telecommunications industry.',
    'Jobs with frequent travel requirements.',
    'Positions requiring a bachelor degree that the candidate lacks.',
    'Roles needing medical-device sales experience.',
    'Channel jobs covering western and international regions.',
  ];
  const result = validateTypedContextRules([
    'DO REJECT:',
    ...conflicting.map((rule) => `- ${rule}`),
    '- Roles dominated by cold prospecting.',
  ].join('\n'));

  assert.deepEqual(result.accepted.map((rule) => rule.text), ['Roles dominated by cold prospecting.']);
  assert.deepEqual(result.rejected.map((rule) => rule.text), conflicting);
  assert.match(result.accepted[0].id, /^legacy-[a-f0-9]{64}$/);
  assert.equal(
    result.accepted[0].id,
    validateTypedContextRules('DO REJECT:\n-  roles DOMINATED by cold prospecting  ').accepted[0].id,
  );
});

test('typed Context validation retires the actual contradictory legacy production bullets', () => {
  const conflicting = [
    'sales roles involving event technology, wireless technology, Cryo Bulk Tank Solutions, heavy industrial/vacuum equipment, water treatment, cash management, retail logistics, or physical construction tools/supplies.',
    'regional or field sales roles covering territories outside the Midwest (e.g., NY Metro, Austin TX, East Coast), even if remote.',
    'roles requiring international territory management (e.g., APAC), international relocation, or located internationally (e.g., London).',
    'direct SMB customer-facing roles (e.g., Dental SaaS).',
  ];
  const result = validateTypedContextRules([
    'DO REJECT:',
    ...conflicting.map((rule) => `- ${rule}`),
    '- Roles dominated by cold prospecting.',
  ].join('\n'));

  assert.deepEqual(result.accepted.map((rule) => rule.text), ['Roles dominated by cold prospecting.']);
  assert.deepEqual(result.rejected.map((rule) => rule.text), conflicting);
  assert.match(
    result.rejected.map((rule) => rule.reason).join(' '),
    /telecom|travel territory|high-travel|customer-segment/i,
  );
});
