import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRequiredWorkBaseEvidence, splitLocationOptions } from '../jobLocationPolicy';

test('shared work-base policy distinguishes compatible, incompatible, and ambiguous evidence', () => {
  assert.equal(classifyRequiredWorkBaseEvidence(['Candidates must reside in Minneapolis, MN.']), 'compatible');
  assert.equal(classifyRequiredWorkBaseEvidence(['This hybrid role requires three days each week in Chicago, IL.']), 'incompatible');
  assert.equal(classifyRequiredWorkBaseEvidence(['This role covers customers in Chicago and Minneapolis.']), 'unknown');
  assert.equal(classifyRequiredWorkBaseEvidence(['Candidates must be based in Chicago or may work anywhere in the United States.']), 'compatible');
  assert.deepEqual(splitLocationOptions('Minneapolis, MN or Chicago, IL; Remote US'), ['Minneapolis, MN', 'Chicago, IL', 'Remote US']);
});
