import assert from 'node:assert/strict';
import test from 'node:test';

import { currentScoreScope } from '../statsScoringScope';

test('changing the Experience prompt version cannot change which saved scores Stats counts', () => {
  const before = currentScoreScope({
    aimInputVersionsHash: 'same-aim-version',
    experienceInputVersionsHash: 'old-experience-version',
  });
  const after = currentScoreScope({
    aimInputVersionsHash: 'same-aim-version',
    experienceInputVersionsHash: 'new-experience-version',
  });
  assert.equal(after.sql, before.sql);
  assert.deepEqual(after.values, before.values);
  assert.ok(!after.values.includes('new-experience-version'));
});

test('Stats continues to require the latest non-invalidated Experience score bound to its passing Aim result', () => {
  const scope = currentScoreScope({ aimInputVersionsHash: 'aim', experienceInputVersionsHash: 'experience' });
  assert.match(scope.sql, /experience\.rank = 1/);
  assert.match(scope.sql, /experience\."staleAt" IS NULL/);
  assert.match(scope.sql, /aim\.passed = true/);
  assert.match(scope.sql, /experience\."sourceAimEventId" = aim\.id/);
  assert.match(scope.sql, /experience\."aimFactualExtractionId" = aim\."aimFactualExtractionId"/);
  assert.match(scope.sql, /experience\."inputBindings"->>'aimSemanticResultHash' = aim\."semanticResultHash"/);
});
