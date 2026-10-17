import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRecoveryCheckpoint, selectCanonicalRecoveryIds } from '../canonicalRecoverySelection';

test('repair rotation continues after repaired rows disappear and new jobs arrive', () => {
  const first = selectCanonicalRecoveryIds(['b', 'c', 'd', 'e'], null, 2);
  assert.deepEqual(first, { ids: ['b', 'c'], afterId: 'c' });
  assert.deepEqual(selectCanonicalRecoveryIds(['a', 'c', 'd', 'e'], first.afterId, 2),
    { ids: ['d', 'e'], afterId: 'e' });
  assert.deepEqual(selectCanonicalRecoveryIds(['a', 'c'], 'e', 2),
    { ids: ['a', 'c'], afterId: 'c' });
});

test('rotation handles empty queues, deduplicates candidates, and wraps without repetition', () => {
  assert.deepEqual(selectCanonicalRecoveryIds([], 'c', 250), { ids: [], afterId: 'c' });
  assert.deepEqual(selectCanonicalRecoveryIds(['c', 'a', 'b', 'b'], 'b', 250),
    { ids: ['c', 'a', 'b'], afterId: 'b' });
});

test('a failed or interrupted employer advances only attempted IDs and cannot pin later work', () => {
  const selected = ['c', 'd', 'e', 'a', 'b'];
  const attempted = new Set(['c', 'a']);
  assert.equal(canonicalRecoveryCheckpoint(selected, attempted), 'c');
  assert.equal(selectCanonicalRecoveryIds(['a', 'b', 'c', 'd', 'e'], 'c', 2).ids[0], 'd');
  attempted.add('d');
  attempted.add('e');
  assert.equal(canonicalRecoveryCheckpoint(selected, attempted), 'a');
  assert.equal(canonicalRecoveryCheckpoint(selected, new Set(['a'])), null);
});
