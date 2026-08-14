import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aimScoringV2ExportEnabled,
  experienceScoringV2ExportEnabled,
  scoringV2ExportGateStatus,
} from '../scoringRuntimeConfig';

test('v2 export gates fail closed and accept only the exact string true', () => {
  assert.deepEqual(scoringV2ExportGateStatus({ NODE_ENV: 'test' }), { aim: false, experience: false });
  for (const value of ['TRUE', '1', 'yes', ' true ', 'false']) {
    assert.equal(aimScoringV2ExportEnabled({ NODE_ENV: 'test', AIM_SCORING_V2_EXPORT_ENABLED: value }), false);
    assert.equal(experienceScoringV2ExportEnabled({ NODE_ENV: 'test', EXPERIENCE_SCORING_V2_EXPORT_ENABLED: value }), false);
  }
  assert.deepEqual(scoringV2ExportGateStatus({
    NODE_ENV: 'test',
    AIM_SCORING_V2_EXPORT_ENABLED: 'true',
    EXPERIENCE_SCORING_V2_EXPORT_ENABLED: 'true',
  }), { aim: true, experience: true });
});
