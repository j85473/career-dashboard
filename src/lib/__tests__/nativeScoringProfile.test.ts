import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as mammoth from 'mammoth';

import { NATIVE_SCORING_SCHEMA_VERSION, STANDARD_PROMPT_VERSION } from '../nativeScoringBatch';
import {
  assertCanonicalScoringResume,
  assertEvaluatorResumeMatches,
  CANONICAL_DSI_FORMAL_TITLE,
  CANONICAL_SCORING_RESUME_SHA256,
} from '../nativeScoringPromptBinding';

const evaluatorPath = '.agents/agents/standard-job-evaluator-v6/agent.md';
const evidencePath = '.agents/minified_evidence.json';
const resumePath = 'data/resumes/JosephLamb_Resume.docx';

test('V6.10.0 standard evaluator is bound to the canonical Workday resume', async () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const resumeBytes = fs.readFileSync(resumePath);
  const resume = await mammoth.extractRawText({ path: resumePath });

  assert.equal(STANDARD_PROMPT_VERSION, 'standard-job-evaluator-v6.10.0');
  assert.match(evaluator, new RegExp(NATIVE_SCORING_SCHEMA_VERSION.replaceAll('.', '\\.')));
  assert.doesNotThrow(() => assertCanonicalScoringResume(resumePath, resumeBytes, resume.value));
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
  assert.match(evaluator, new RegExp(CANONICAL_DSI_FORMAL_TITLE));
  assert.doesNotMatch(evaluator, /claim(?:s|ed|ing)? the title Channel Account Manager/i);
  assert.doesNotMatch(evaluator, /DSI title claimed on the resume is Channel Account Manager/i);
  assert.doesNotMatch(evaluator, /consecutive 15/);
});

test('canonical scoring resume contract fails on basename, bytes, and the CAM title variant', async () => {
  const resumeBytes = fs.readFileSync(resumePath);
  const resume = await mammoth.extractRawText({ path: resumePath });

  assert.throws(
    () => assertCanonicalScoringResume('data/resumes/renamed.docx', resumeBytes, resume.value),
    /must be named JosephLamb_Resume\.docx/,
  );
  assert.throws(
    () => assertCanonicalScoringResume(resumePath, Buffer.concat([resumeBytes, Buffer.from('changed')]), resume.value),
    new RegExp(`SHA-256 must be ${CANONICAL_SCORING_RESUME_SHA256}`),
  );
  assert.throws(
    () => assertCanonicalScoringResume(
      resumePath,
      resumeBytes,
      resume.value.replace(CANONICAL_DSI_FORMAL_TITLE, 'Channel Account Manager'),
    ),
    /must use the formal DSI title/,
  );
});

test('V6.10.0 evaluator embeds the exact trusted evidence mirror', () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');
  const embedded = /### Minified Evidence Inventory\s*```json\s*([\s\S]*?)\s*```/.exec(evaluator);
  assert.ok(embedded, 'standard evaluator must embed the evidence inventory');

  const trusted = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
  assert.deepEqual(JSON.parse(embedded[1]), trusted);
  assert.match(embedded[1], /"id": "DSI-019"/);
  assert.match(embedded[1], /"id": "DSI-021"/);
});

test('V6.10.0 evaluator states the required-domain cross-field invariants without contradiction', () => {
  const evaluator = fs.readFileSync(evaluatorPath, 'utf8');

  assert.match(evaluator, /requiredDomain` is the specialized domain explicitly required by the JD, or null only when none is required/);
  assert.match(evaluator, /An unsupported required domain must still be named in `requiredDomain`/);
  assert.match(evaluator, /Never return a numeric required-domain tenure with `requiredDomain: null`/);
  assert.doesNotMatch(evaluator, /Use null only when no domain is required or the required domain is unsupported/);
});
