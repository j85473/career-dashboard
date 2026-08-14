import assert from 'node:assert/strict';
import test from 'node:test';

import policySource from '../../../data/scoring/aim-policy-v2.json';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy, validateAimScoringPolicy } from '../aimScoringPolicy';

test('Aim v2 policy is the immutable provisional preference authority', () => {
  const { registry } = loadAimQuestionRegistry();
  const loaded = loadAimScoringPolicy(registry);
  assert.equal(loaded.scoringPolicyHash, '3af1eaf21fd09a70839a9b9c3eecc27c4a07a04759ad453ede081c38eef850cb');
  assert.deepEqual(Object.fromEntries(Object.entries(loaded.policy.preferenceScoring.components).map(([name, value]) => [name, [value.minimum, value.cap]])), {
    travel: [-8, 30],
    building: [0, 30],
    autonomy: [0, 22],
    channelPartnership: [0, 8],
    farming: [0, 5],
    industryInterest: [-5, 5],
    technicalPresalesDeduction: [-14, 0],
    huntingDeduction: [-20, 0],
  });
  assert.deepEqual(loaded.policy.bands.map((band) => [band.minimum, band.maximum]), [[85, 100], [70, 84], [55, 69], [40, 54], [0, 39]]);
  assert.equal(Object.isFrozen(loaded.policy.preferenceScoring.components), true);
  assert.throws(() => loadAimScoringPolicy(registry, 'f'.repeat(64)), /hash mismatch/);
});

test('Aim v2 policy rejects unknown question references and alternate caps', () => {
  const { registry } = loadAimQuestionRegistry();
  const unknown = structuredClone(policySource);
  unknown.preferenceScoring.components.building.tiers![0]!.predicate.ids!.push('S2.F7.Q99');
  assert.throws(() => validateAimScoringPolicy(unknown, registry), /unknown question/);

  const alteredCap = structuredClone(policySource);
  alteredCap.preferenceScoring.components.travel.cap = 29;
  assert.throws(() => validateAimScoringPolicy(alteredCap, registry), /component range/);
});
