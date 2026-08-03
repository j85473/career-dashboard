import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEvaluatorResumeMatches,
  evaluatorResumeSection,
} from '../nativeScoringPromptBinding';

const liveResume = `JOSEPH LAMB
j85473@example.com\t920-960-3723\tlinkedin.com/in/example\tgithub.com/example

Channel Sales | Partner Enablement

Built a partner program.`;

const prompt = `# Evaluator

## 1. Candidate Resume
JOSEPH LAMB

Channel Sales | Partner Enablement

Built a partner program.

## 2. Context Rules
Rules follow.`;

test('evaluator resume binding ignores only top-of-resume contact details', () => {
  assert.doesNotThrow(() => assertEvaluatorResumeMatches(
    prompt,
    '## 2. Context Rules',
    liveResume,
    'standard',
  ));
  assert.equal(
    evaluatorResumeSection(prompt, '## 2. Context Rules').includes('Built a partner program.'),
    true,
  );
});

test('evaluator resume binding fails closed when candidate evidence changes', () => {
  assert.throws(
    () => assertEvaluatorResumeMatches(
      prompt,
      '## 2. Context Rules',
      liveResume.replace('Built a partner program.', 'Managed a partner program.'),
      'standard',
    ),
    /does not match the current baseline resume/,
  );
});

test('evaluator resume binding requires an explicit section boundary', () => {
  assert.throws(
    () => evaluatorResumeSection(prompt, '## 2. Wildcard Profile'),
    /missing its ## 2\. Wildcard Profile boundary/,
  );
});
