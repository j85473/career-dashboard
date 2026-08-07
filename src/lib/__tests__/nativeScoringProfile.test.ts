import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as mammoth from 'mammoth';

import { NATIVE_SCORING_SCHEMA_VERSION, STANDARD_PROMPT_VERSION } from '../nativeScoringBatch';
import { assertEvaluatorResumeMatches } from '../nativeScoringPromptBinding';

const evaluatorPath = '.agents/agents/standard-job-evaluator-v6/agent.md';
const evidencePath = '.agents/minified_evidence.json';
const resumePath = 'data/resumes/Joseph_Lamb_Channel_Sales_Resume_v3.docx';

test('V6.7.1 standard evaluator is bound to the frozen channel-sales resume', async () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const resume = await mammoth.extractRawText({ path: resumePath });

  assert.equal(STANDARD_PROMPT_VERSION, 'standard-job-evaluator-v6.7.1');
  assert.match(evaluator, new RegExp(NATIVE_SCORING_SCHEMA_VERSION.replaceAll('.', '\\.')));
  assert.doesNotThrow(() => assertEvaluatorResumeMatches(
    evaluator,
    '## 2. Context Rules & Policy Precedence',
    resume.value,
    'standard',
  ));
  // The .docx pads its separators, so mammoth extracts multiple spaces around
  // each `|` and `·`. Match flexible whitespace or these silently fail.
  assert.match(evaluator, /CHANNEL SALES\s+\|\s+DISTRIBUTOR & PARTNER MANAGEMENT\s+\|\s+MULTI-STATE TERRITORY GROWTH/);
  assert.match(evaluator, /Channel Partner Management\s+·\s+Joint Business Planning\s+·\s+Sell-Through Performance/);
  assert.doesNotMatch(evaluator, /consecutive 15/);
});

test('V6.7.1 evaluator embeds the exact trusted evidence mirror', () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const embedded = /### Minified Evidence Inventory\s*```json\s*([\s\S]*?)\s*```/.exec(evaluator);
  assert.ok(embedded, 'standard evaluator must embed the evidence inventory');

  const trusted = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
  assert.deepEqual(JSON.parse(embedded[1]), trusted);
  assert.match(embedded[1], /"id": "DSI-019"/);
  assert.match(embedded[1], /"id": "DSI-021"/);
});

test('V6.7.1 evaluator states the required-domain cross-field invariants without contradiction', () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');

  assert.match(evaluator, /requiredDomain` is the specialized domain explicitly required by the JD, or null only when none is required/);
  assert.match(evaluator, /An unsupported required domain must still be named in `requiredDomain`/);
  assert.match(evaluator, /Never return a numeric required-domain tenure with `requiredDomain: null`/);
  assert.doesNotMatch(evaluator, /Use null only when no domain is required or the required domain is unsupported/);
});
