import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScore,
  guardedStandardExperienceScore,
  passesStandardScoring,
  passesWildcardScoring,
  qualifiesForWildcardAfterStandard,
} from '../scoringPolicy';

test('score clamping keeps values inside the persisted 0-100 range', () => {
  assert.equal(clampScore(-4.2), 0);
  assert.equal(clampScore(75.6), 76);
  assert.equal(clampScore(103), 100);
});

test('standard pass threshold has no source-based bypass, including manual imports', () => {
  assert.equal(passesStandardScoring(80, 70), true);
  assert.equal(passesStandardScoring(100, 69), false);
  assert.equal(passesStandardScoring(79, 100), false);
  assert.equal(passesStandardScoring(100, 59), false);
});

test('mandatory, domain, and tenure guardrails deterministically veto inflated experience scores', () => {
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 92,
    mandatoryRequirementsMet: false,
    domainMatch: true,
    requiredYearsInDomain: null,
    candidateYearsInDomain: null,
  }), 59);
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 90,
    mandatoryRequirementsMet: true,
    domainMatch: false,
    requiredYearsInDomain: 5,
    candidateYearsInDomain: 0,
  }), 59);
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 88,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: 5,
    candidateYearsInDomain: null,
  }), 59);
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 84,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: 5,
    candidateYearsInDomain: 7,
  }), 84);
});

test('wildcard pass threshold requires both scores to reach 85', () => {
  assert.equal(passesWildcardScoring(85, 85), true);
  assert.equal(passesWildcardScoring(84, 100), false);
  assert.equal(passesWildcardScoring(100, 84), false);
});

test('only high-experience A/E rejects become newly wildcard eligible', () => {
  assert.equal(qualifiesForWildcardAfterStandard(79, 85), true);
  assert.equal(qualifiesForWildcardAfterStandard(20, 84), false);
  assert.equal(qualifiesForWildcardAfterStandard(80, 85), false);
});
