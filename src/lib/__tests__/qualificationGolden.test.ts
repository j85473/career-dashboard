import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCriterionExperienceScore } from '../experienceScoringPolicy';

const directGoldenJobs = ['Jaeckle', 'Sazerac', 'Taylor', 'Nametag'];
const partialGoldenJobs = ['Customer-success software role', 'Channel-software role'];
const conflictGoldenJobs = [
  'Abbott',
  'Tellius',
  'Impossible Foods',
  'Medtronic',
  'Atomic Data',
  'Epicor',
  'Five9',
];

test('V7 criterion golden classes enforce direct, partial, unknown, and conflict bands', () => {
  for (const company of directGoldenJobs) {
    const result = deriveCriterionExperienceScore([
      { classification: 'required', outcome: 'direct' },
      { classification: 'required', outcome: 'direct' },
    ]);
    assert.equal(result.experienceFitScore, 100, company);
    assert.equal(result.cap, null, company);
  }
  for (const company of partialGoldenJobs) {
    const result = deriveCriterionExperienceScore([
      { classification: 'required', outcome: 'direct' },
      { classification: 'required', outcome: 'partial' },
    ]);
    assert.equal(result.experienceFitScore, 75, company);
    assert.equal(result.cap, 79, company);
  }
  for (const company of conflictGoldenJobs) {
    const result = deriveCriterionExperienceScore([
      { classification: 'required', outcome: 'direct' },
      { classification: 'required', outcome: 'does_not_meet' },
    ]);
    assert.equal(result.experienceFitScore, 50, company);
    assert.equal(result.cap, 59, company);
  }
  const unknown = deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'cannot_evaluate' },
  ]);
  assert.equal(unknown.experienceFitScore, 50);
  assert.equal(unknown.cap, 69);
});

test('administrative and unknown professional credential criteria remain score-neutral', () => {
  const result = deriveCriterionExperienceScore([
    { classification: 'required', outcome: 'direct' },
    { classification: 'required', outcome: 'excluded' },
    { classification: 'required', outcome: 'cannot_evaluate', scoreNeutral: true },
  ]);
  assert.equal(result.experienceFitScore, 100);
});
