import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRequiredWorkBaseEvidence, isGeneralRemoteOption, splitLocationOptions } from '../jobLocationPolicy';

test('shared work-base policy distinguishes compatible, incompatible, and ambiguous evidence', () => {
  assert.equal(classifyRequiredWorkBaseEvidence(['Candidates must reside in Minneapolis, MN.']), 'compatible');
  assert.equal(classifyRequiredWorkBaseEvidence(['This hybrid role requires three days each week in Chicago, IL.']), 'incompatible');
  assert.equal(classifyRequiredWorkBaseEvidence(['This role covers customers in Chicago and Minneapolis.']), 'unknown');
  assert.equal(classifyRequiredWorkBaseEvidence(['Candidates must be based in Chicago or may work anywhere in the United States.']), 'compatible');
  assert.deepEqual(splitLocationOptions('Minneapolis, MN or Chicago, IL; Remote US'), ['Minneapolis, MN', 'Chicago, IL', 'Remote US']);
});

test('duplicate remote labels retain their existing separator and geography rules', () => {
  for (const location of ['Remote Remote', 'Remote-Remote', 'Remote : Remote',
    'RemoteRemote', 'Remote\t-\tRemote', 'Remote - Remote - United States']) {
    assert.equal(isGeneralRemoteOption(location), true, location);
  }
  for (const location of ['Remote--Remote', 'Remote::Remote', 'Remote-Remote Chicago, IL',
    'Remote Remote Europe', 'Remote RemoteX']) {
    assert.equal(isGeneralRemoteOption(location), false, location);
  }
});

test('long repeated remote labels and nonmatching suffixes finish without backtracking', () => {
  const repeated = 'Remote\t'.repeat(20_000);
  assert.equal(isGeneralRemoteOption(repeated + 'Remote'), true);
  assert.equal(isGeneralRemoteOption(repeated + 'RemoteX'), false);
  assert.equal(isGeneralRemoteOption('Remote' + '\t'.repeat(100_000) + ': Remote'), true);
});
