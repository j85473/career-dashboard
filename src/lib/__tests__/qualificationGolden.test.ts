import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedStandardExperienceScore, passesStandardScoring } from '../scoringPolicy';

const directGoldenJobs = ['Jaeckle', 'Sazerac', 'Taylor', 'Nametag'];
const adjacentGoldenJobs = ['Customer-success software role', 'Channel-software role'];
const rejectedGoldenJobs = [
  'Abbott',
  'Tellius',
  'Impossible Foods',
  'Medtronic',
  'Atomic Data',
  'Epicor',
  'Five9',
];

test('V6.5 golden qualification classes enforce their maximum experience bands', () => {
  for (const company of directGoldenJobs) {
    assert.equal(guardedStandardExperienceScore({
      experienceFitScore: 86,
      mandatoryRequirementsMet: true,
      domainMatch: true,
      requiredYearsInDomain: null,
      candidateYearsInDomain: null,
      qualificationBasis: 'direct',
    }), 86, company);
  }
  for (const company of adjacentGoldenJobs) {
    assert.equal(guardedStandardExperienceScore({
      experienceFitScore: 91,
      mandatoryRequirementsMet: true,
      domainMatch: true,
      requiredYearsInDomain: null,
      candidateYearsInDomain: null,
      qualificationBasis: 'adjacent',
    }), 79, company);
  }
  for (const company of rejectedGoldenJobs) {
    assert.equal(guardedStandardExperienceScore({
      experienceFitScore: 95,
      mandatoryRequirementsMet: false,
      domainMatch: true,
      requiredYearsInDomain: null,
      candidateYearsInDomain: null,
      qualificationBasis: 'unsupported',
    }), 59, company);
  }
});

test('Bayer-style administrative driver requirement does not change an otherwise direct Experience pass', () => {
  const guardedExperience = guardedStandardExperienceScore({
    experienceFitScore: 92,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: null,
    candidateYearsInDomain: null,
    qualificationBasis: 'direct',
  });

  assert.equal(guardedExperience, 92);
  assert.equal(passesStandardScoring(95, guardedExperience), true);
});

test('a clean-driving-record clause remains outside Experience guardrails', () => {
  const guardedExperience = guardedStandardExperienceScore({
    experienceFitScore: 85,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: null,
    candidateYearsInDomain: null,
    qualificationBasis: 'direct',
  });

  assert.equal(guardedExperience, 85);
  assert.equal(passesStandardScoring(90, guardedExperience), true);
});
