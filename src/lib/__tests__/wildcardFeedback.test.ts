import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendWildcardFeedback,
  MAX_WILDCARD_FEEDBACK_ENTRIES,
  MAX_WILDCARD_FEEDBACK_PROMPT_CHARS,
  splitWildcardProfile,
  wildcardFeedbackForPrompt,
} from '../wildcardFeedback';

test('wildcard feedback stays in a scoped section and preserves the base profile', () => {
  const base = '# Wildcard profile\n\n- Prefer builder roles.';
  const withPromotion = appendWildcardFeedback(base, {
    decision: 'promote',
    title: 'Chief of Staff',
    company: 'Example',
    reason: 'Strong 0-to-1 ownership',
  });
  const withPass = appendWildcardFeedback(withPromotion, {
    decision: 'pass',
    title: 'Program Lead',
    company: 'Example',
    reason: 'Too focused on internal reporting',
  });
  const split = splitWildcardProfile(withPass);

  assert.equal(split.baseProfileText, base);
  assert.equal(split.feedbackEntries.length, 2);
  assert.match(split.feedbackEntries[0], /POSITIVE_OVERRIDE/);
  assert.match(split.feedbackEntries[1], /NEGATIVE_PASS/);
});

test('wildcard feedback is deduplicated, sanitized, and bounded to recent decisions', () => {
  let profile = '- Base rule';
  for (let index = 0; index < MAX_WILDCARD_FEEDBACK_ENTRIES + 5; index += 1) {
    profile = appendWildcardFeedback(profile, {
      decision: 'pass',
      title: `Role ${index}`,
      company: 'Example',
      reason: `Reason ${index}\nwith a second line`,
    });
  }

  const split = splitWildcardProfile(profile);
  assert.equal(split.feedbackEntries.length, MAX_WILDCARD_FEEDBACK_ENTRIES);
  assert.doesNotMatch(split.feedbackEntries.join('\n'), /Role 0/);
  assert.match(split.feedbackEntries.at(-1) || '', /Role 24/);
  assert.doesNotMatch(split.feedbackEntries.at(-1) || '', /\n/);

  const duplicate = appendWildcardFeedback(profile, {
    decision: 'pass',
    title: 'Role 24',
    company: 'Example',
    reason: 'Reason 24 with a second line',
  });
  assert.equal(splitWildcardProfile(duplicate).feedbackEntries.length, MAX_WILDCARD_FEEDBACK_ENTRIES);
});

test('wildcard prompt feedback keeps the newest entries within a hard character budget', () => {
  let profile = '- Base rule';
  for (let index = 0; index < MAX_WILDCARD_FEEDBACK_ENTRIES; index += 1) {
    profile = appendWildcardFeedback(profile, {
      decision: 'promote',
      title: `Role ${index}`,
      company: 'Example',
      reason: `${index} ${'useful signal '.repeat(40)}`,
    });
  }

  const prompt = wildcardFeedbackForPrompt(profile);
  assert.ok(prompt.explicitFeedback.length <= MAX_WILDCARD_FEEDBACK_PROMPT_CHARS);
  assert.match(prompt.explicitFeedback, /Role 19/);
  assert.equal(prompt.baseProfileText, '- Base rule');
});
