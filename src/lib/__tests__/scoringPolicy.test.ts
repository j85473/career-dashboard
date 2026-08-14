import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveCriterionExperienceScore,
  clampScore,
} from '../experienceScoringPolicy';

test('criterion Experience scoring owns 80/20 weighting, normalization, and required caps', () => {
  assert.deepEqual(
    deriveCriterionExperienceScore([
      { classification: 'required', outcome: 'direct' },
      { classification: 'required', outcome: 'partial' },
      { classification: 'preferred', outcome: 'direct' },
      { classification: 'preferred', outcome: 'cannot_evaluate' },
    ]),
    {
      uncappedScore: 70,
      experienceFitScore: 70,
      cap: 79,
      label: 'Partially qualified',
      requiredCounts: { direct: 1, partial: 1, cannot_evaluate: 0, does_not_meet: 0, excluded: 0 },
      preferredCounts: { direct: 1, partial: 0, cannot_evaluate: 1, does_not_meet: 0, excluded: 0 },
    },
  );
  assert.equal(deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'partial' },
  ]).experienceFitScore, 75);
  assert.equal(deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'cannot_evaluate' },
  ]).experienceFitScore, 50);
  assert.equal(deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'does_not_meet' },
  ]).cap, 59);
});

test('excluded and score-neutral credential criteria do not affect denominators or caps', () => {
  const result = deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'excluded' },
    { classification: 'required', outcome: 'cannot_evaluate', scoreNeutral: true },
  ]);
  assert.equal(result.uncappedScore, 100);
  assert.equal(result.experienceFitScore, 100);
  assert.equal(result.cap, null);
  assert.equal(result.label, 'Fully qualified');

  const entirelyNeutral = deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'cannot_evaluate', scoreNeutral: true },
  ]);
  assert.equal(entirelyNeutral.experienceFitScore, 100);
  assert.equal(entirelyNeutral.cap, null);
});

test('score clamping keeps values inside the persisted 0-100 range', () => {
  assert.equal(clampScore(-4.2), 0);
  assert.equal(clampScore(75.6), 76);
  assert.equal(clampScore(103), 100);
});
