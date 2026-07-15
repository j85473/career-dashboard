import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScore,
  passesStandardScoring,
  passesWildcardScoring,
} from '../scoringPolicy';

test('score clamping keeps values inside the persisted 0-100 range', () => {
  assert.equal(clampScore(-4.2), 0);
  assert.equal(clampScore(75.6), 76);
  assert.equal(clampScore(103), 100);
});

test('standard pass threshold has no source-based bypass, including manual imports', () => {
  assert.equal(passesStandardScoring(80, 60), true);
  assert.equal(passesStandardScoring(79, 100), false);
  assert.equal(passesStandardScoring(100, 59), false);
});

test('wildcard pass threshold requires both scores to reach 85', () => {
  assert.equal(passesWildcardScoring(85, 85), true);
  assert.equal(passesWildcardScoring(84, 100), false);
  assert.equal(passesWildcardScoring(100, 84), false);
});
