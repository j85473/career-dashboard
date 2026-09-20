import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');

test('mobile tab navigation locks swipe gestures to its horizontal scroller', () => {
  const mobileRulesStart = css.indexOf('@media (max-width: 768px)');
  const navigationRuleStart = css.indexOf('.nav-tabs {', mobileRulesStart);
  const navigationRuleEnd = css.indexOf('\n  }', navigationRuleStart);
  const navigationRule = css.slice(navigationRuleStart, navigationRuleEnd);

  assert.ok(mobileRulesStart >= 0, 'mobile rules exist');
  assert.ok(navigationRuleStart > mobileRulesStart, 'mobile navigation rule exists');
  assert.match(navigationRule, /overflow-x:\s*auto;/);
  assert.match(navigationRule, /touch-action:\s*pan-x pinch-zoom;/);
  assert.match(navigationRule, /overscroll-behavior-x:\s*contain;/);
});
