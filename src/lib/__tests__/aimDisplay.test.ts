import assert from 'node:assert/strict';
import test from 'node:test';

import { aimDisplayFromAssessment, aimScoreFillClass, aimV2DisplayBand } from '../aimDisplay';

test('Aim v2 display bands use the exact 85/70/55/40 boundaries', () => {
  const cases = [
    [100, 'exceptional'], [85, 'exceptional'], [84, 'strong'], [70, 'strong'],
    [69, 'good'], [55, 'good'], [54, 'mixed'], [40, 'mixed'], [39, 'low'], [0, 'low'],
  ] as const;
  for (const [score, code] of cases) assert.equal(aimV2DisplayBand(score).code, code);
  for (const invalid of [-1, 101, 40.5, Number.NaN]) {
    assert.throws(() => aimV2DisplayBand(invalid), /integer from zero through 100/);
  }
});

test('Aim v2 assessment display fails closed on a forged band', () => {
  const expected = aimV2DisplayBand(85);
  assert.deepEqual(aimDisplayFromAssessment({ variant: 'scored_survivor', score: 85, band: expected }), expected);
  assert.equal(aimDisplayFromAssessment({
    variant: 'scored_survivor', score: 85, band: { ...expected, code: 'strong' },
  }), null);
  assert.equal(aimDisplayFromAssessment({ variant: 'factual_screen_kill', score: null }), null);
});

test('historical Aim fill thresholds remain isolated from v2 display bands', () => {
  assert.equal(aimScoreFillClass(70, 'career-dashboard-aim-result-v2'), 'fill-blue');
  assert.equal(aimScoreFillClass(70, 'career-dashboard-aim-result-v1'), 'fill-amber');
  assert.equal(aimScoreFillClass(80, 'career-dashboard-aim-result-v1'), 'fill-green');
});
