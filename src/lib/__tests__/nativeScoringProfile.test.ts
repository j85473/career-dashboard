import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as mammoth from 'mammoth';

import { NATIVE_SCORING_SCHEMA_VERSION, STANDARD_PROMPT_VERSION } from '../nativeScoringBatch';
import { assertEvaluatorResumeMatches } from '../nativeScoringPromptBinding';

const evaluatorPath = '.agents/agents/standard-job-evaluator-v6/agent.md';
const evidencePath = '.agents/minified_evidence.json';
const resumePath = 'data/resumes/Joseph_Lamb_Core_Commercial_Growth_Resume_v2.docx';

test('V6.6 standard evaluator is bound to the frozen commercial-growth resume', async () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const resume = await mammoth.extractRawText({ path: resumePath });

  assert.equal(STANDARD_PROMPT_VERSION, 'standard-job-evaluator-v6.6');
  assert.match(evaluator, new RegExp(NATIVE_SCORING_SCHEMA_VERSION.replaceAll('.', '\\.')));
  assert.doesNotThrow(() => assertEvaluatorResumeMatches(
    evaluator,
    '## 2. Context Rules & Policy Precedence',
    resume.value,
    'standard',
  ));
  assert.match(evaluator, /MULTI-STATE TERRITORY GROWTH \| DISTRIBUTOR & CHANNEL MANAGEMENT \| B2B FIELD SALES/);
});

test('V6.6 evaluator embeds the exact trusted evidence mirror', () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const embedded = /### Minified Evidence Inventory\s*```json\s*([\s\S]*?)\s*```/.exec(evaluator);
  assert.ok(embedded, 'standard evaluator must embed the evidence inventory');

  const trusted = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
  assert.deepEqual(JSON.parse(embedded[1]), trusted);
  assert.match(embedded[1], /"id": "DSI-019"/);
  assert.match(embedded[1], /"id": "DSI-021"/);
});
