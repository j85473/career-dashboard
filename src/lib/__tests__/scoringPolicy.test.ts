import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScore,
  guardedStandardExperienceScore,
  passesStandardScoring,
  standardAdmissionDecision,
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

test('priority admission never rewrites a failed A/E result as a machine pass', () => {
  assert.deepEqual(standardAdmissionDecision(92, 88, true), {
    machinePassed: true,
    overrideApplied: false,
    admittedToInbox: true,
  });
  assert.deepEqual(standardAdmissionDecision(45, 59, true), {
    machinePassed: false,
    overrideApplied: true,
    admittedToInbox: true,
  });
  assert.deepEqual(standardAdmissionDecision(45, 59, false), {
    machinePassed: false,
    overrideApplied: false,
    admittedToInbox: false,
  });
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
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 94,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: null,
    candidateYearsInDomain: null,
    qualificationBasis: 'adjacent',
  }), 79);
  assert.equal(guardedStandardExperienceScore({
    experienceFitScore: 94,
    mandatoryRequirementsMet: true,
    domainMatch: true,
    requiredYearsInDomain: null,
    candidateYearsInDomain: null,
    qualificationBasis: 'unsupported',
  }), 59);
});
