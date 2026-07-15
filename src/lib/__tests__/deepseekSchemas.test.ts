import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateStandardEvaluation,
  validateWildcardEvaluation,
} from '../deepseekSchemas';

function standardScore(id: string) {
  return {
    id,
    required_domain: 'Cybersecurity',
    candidate_domain: 'General B2B sales only',
    domain_match: false,
    required_years_in_domain: 5,
    candidate_years_in_domain: 0,
    aimFitScore: 105,
    aimFitReason: 'The work pattern aligns with stated preferences.',
    experienceFitScore: 92,
    experienceFitReason: 'The mandatory cybersecurity background is absent.',
    travelScore: -3,
    atsSystem: null,
  };
}

test('standard validation clamps scores and enforces the domain mismatch cap in code', () => {
  const result = validateStandardEvaluation({
    updatedContextRules: 'Legacy context text that is not bulleted',
    processedContextJobIds: ['feedback-1', 'invented-id'],
    jobScores: [standardScore('job-1')],
  }, new Set(['job-1']), new Set(['feedback-1']), 'Legacy context text that is not bulleted');

  assert.equal(result.jobScores[0].aimFitScore, 100);
  assert.equal(result.jobScores[0].experienceFitScore, 59);
  assert.equal(result.jobScores[0].travelScore, 0);
  assert.deepEqual(result.processedContextJobIds, ['feedback-1']);
});

test('standard validation caps experience below passing when explicit required years exceed candidate years', () => {
  const score = {
    ...standardScore('job-1'),
    domain_match: true,
    required_years_in_domain: 7,
    candidate_years_in_domain: 4.5,
    experienceFitScore: 94,
  };
  const result = validateStandardEvaluation({
    updatedContextRules: '- Keep existing rules.',
    processedContextJobIds: [],
    jobScores: [score],
  }, new Set(['job-1']), new Set());

  assert.equal(result.jobScores[0].domainMatch, true);
  assert.equal(result.jobScores[0].experienceFitScore, 59);
});

test('years guardrail does not invent a deficit when years are unknown or requirement is met', () => {
  const unknownYears = {
    ...standardScore('job-1'),
    domain_match: true,
    required_years_in_domain: 7,
    candidate_years_in_domain: null,
    experienceFitScore: 84,
  };
  const meetsRequirement = {
    ...standardScore('job-2'),
    domain_match: true,
    required_years_in_domain: 7,
    candidate_years_in_domain: 7,
    experienceFitScore: 84,
  };
  const result = validateStandardEvaluation({
    updatedContextRules: '- Keep existing rules.',
    processedContextJobIds: [],
    jobScores: [unknownYears, meetsRequirement],
  }, new Set(['job-1', 'job-2']), new Set());

  assert.deepEqual(result.jobScores.map((score) => score.experienceFitScore), [84, 84]);
});

test('unsubmitted, duplicated, and malformed entries are rejected without fabricating scores', () => {
  const malformed = { ...standardScore('job-2'), aimFitScore: '90' };
  const result = validateStandardEvaluation({
    updatedContextRules: '- Keep the current rules.',
    processedContextJobIds: [],
    jobScores: [standardScore('job-1'), standardScore('job-1'), malformed, standardScore('invented')],
  }, new Set(['job-1', 'job-2', 'job-3']), new Set());

  assert.deepEqual(result.jobScores.map((score) => score.id), ['job-1']);
  assert.deepEqual(result.omittedJobIds.sort(), ['job-2', 'job-3']);
  assert.equal(result.rejectedEntries, 3);
});

test('context processing-log noise is isolated without discarding valid scores', () => {
  const result = validateStandardEvaluation({
    updatedContextRules: '- Processed job ABC successfully',
    processedContextJobIds: ['feedback-1'],
    jobScores: [standardScore('job-1')],
  }, new Set(['job-1']), new Set(['feedback-1']), '- Keep existing rules.');

  assert.equal(result.contextUpdateRejected, true);
  assert.equal(result.jobScores.length, 1);
  assert.deepEqual(result.processedContextJobIds, []);
});

test('a response with no valid submitted scores is retryable instead of silently accepted', () => {
  assert.throws(() => validateStandardEvaluation({
    updatedContextRules: '- Keep the current rules.',
    processedContextJobIds: [],
    jobScores: [standardScore('invented-id')],
  }, new Set(['job-1']), new Set()), /no valid submitted job scores/);
});

test('wildcard validation accepts only submitted IDs and reports omissions for retry', () => {
  const result = validateWildcardEvaluation({
    jobScores: [
      {
        id: 'wild-1',
        vibeFitScore: 110,
        vibeFitReason: 'Strong builder autonomy.',
        experienceFitScore: 86,
        experienceFitReason: 'Transferable operating experience is demonstrated.',
      },
      {
        id: 'hallucinated',
        vibeFitScore: 99,
        vibeFitReason: 'Unknown.',
        experienceFitScore: 99,
        experienceFitReason: 'Unknown.',
      },
    ],
  }, new Set(['wild-1', 'wild-2']));

  assert.equal(result.jobScores[0].vibeFitScore, 100);
  assert.deepEqual(result.omittedJobIds, ['wild-2']);
  assert.equal(result.rejectedEntries, 1);
});
