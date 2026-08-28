import assert from 'node:assert/strict';
import test from 'node:test';

import { cooldownReleasePlan, statusAfterCooldown } from '../cooldownRecovery';
import type { LatestJobScoreBundle } from '../jobScoreAuthorityQuery';

test('an expired Cooldown row without score authority re-enters current local scoring', () => {
  assert.deepEqual(cooldownReleasePlan(null), {
    status: 'pending_af',
    queueLocalScoring: true,
  });
  assert.equal(statusAfterCooldown(null), 'pending_af');
});

test('an empty score bundle is treated as unscored and cannot bypass local scoring', () => {
  const emptyBundle = {
    legacy: null,
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } satisfies LatestJobScoreBundle;
  assert.deepEqual(cooldownReleasePlan(emptyBundle), {
    status: 'pending_af',
    queueLocalScoring: true,
  });
});

test('current legacy score authority keeps its existing lifecycle projection', () => {
  const bundle = {
    legacy: {
      evaluationType: 'standard',
      staleAt: null,
      passed: true,
    },
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.deepEqual(cooldownReleasePlan(bundle), {
    status: 'inbox',
    queueLocalScoring: false,
  });
});
