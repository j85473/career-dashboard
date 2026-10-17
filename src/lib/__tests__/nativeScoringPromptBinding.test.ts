import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as mammoth from 'mammoth';

import {
  assertCanonicalScoringResume,
  assertEvaluatorResumeMatches,
  CANONICAL_SCORING_RESUME_SHA256,
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

test('evaluator resume binding tolerates DOCX manual-line-break whitespace only', () => {
  const wrappedPrompt = prompt.replace(
    'Channel Sales | Partner Enablement',
    'Channel Sales |\nPartner Enablement',
  );
  assert.doesNotThrow(() => assertEvaluatorResumeMatches(
    wrappedPrompt,
    '## 2. Context Rules',
    liveResume,
    'standard',
  ));
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
    () => evaluatorResumeSection(prompt, '## 2. Missing Policy Boundary'),
    /missing its ## 2\. Missing Policy Boundary boundary/,
  );
});

test('repository scoring resume matches the locked bytes and formal title', async () => {
  const filePath = 'data/resumes/JosephLamb_Resume.docx';
  const bytes = fs.readFileSync(filePath);
  const extractedText = (await mammoth.extractRawText({ buffer: bytes })).value;
  assert.equal(CANONICAL_SCORING_RESUME_SHA256, '59e93946815686f11f40bbe9c44382f87a43afec36f4f1ffa8384f78cef95e5c');
  assert.doesNotThrow(() => assertCanonicalScoringResume(filePath, bytes, extractedText));
  assert.throws(
    () => assertCanonicalScoringResume(
      filePath,
      bytes,
      extractedText.replace(' (official title: Field Sales Representative)', ''),
    ),
    /must use the formal DSI title/,
  );
});
