import assert from 'node:assert/strict';
import test from 'node:test';

import { travelOpportunityFill, travelOpportunityTier } from '../travelOpportunity';

test('high travel is modeled as a positive opportunity signal', () => {
  assert.equal(travelOpportunityTier(100), 'priority');
  assert.equal(travelOpportunityTier(90), 'priority');
  assert.equal(travelOpportunityTier(75), 'high');
  assert.equal(travelOpportunityFill(75), 'fill-green');
});

test('moderate travel is useful and low travel is neutral rather than negative', () => {
  assert.equal(travelOpportunityTier(50), 'moderate');
  assert.equal(travelOpportunityFill(50), 'fill-blue');
  assert.equal(travelOpportunityTier(25), 'low');
  assert.equal(travelOpportunityFill(25), 'fill-muted');
  assert.equal(travelOpportunityTier(null), 'unscored');
});
