import assert from 'node:assert/strict';
import test from 'node:test';
import { manualScoringStatusWhere } from '../manualScoringEligibility';

/**
 * These assert the *shape* of the filter, because the defect they guard is a
 * SQL three-valued-logic trap that a shape-blind test cannot see:
 * `NULL LIKE '…'` evaluates to NULL, `NOT NULL` is NULL, and NULL is not true,
 * so a bare NOT over a nullable column silently drops every row where it is
 * null. Every job that has never been passed has a null `passReason`, so the
 * Aim Fit queue reported 3 eligible jobs out of 26,225.
 */

function findPassReasonBranch(where: unknown): unknown {
  let found: unknown = null;
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const record = node as Record<string, unknown>;
    if ('passReason' in record) found ||= node;
    Object.values(record).forEach(walk);
  };
  walk(where);
  return found;
}

test('the aim filter tolerates a null passReason', () => {
  const where = manualScoringStatusWhere('aim') as Record<string, unknown>;
  const serialised = JSON.stringify(where);
  // The null case has to be admitted explicitly; nothing else makes the
  // comparison null-safe in SQL.
  assert.ok(
    serialised.includes('"passReason":null'),
    'a null passReason must be an explicit alternative, or every unpassed job is excluded',
  );
  assert.ok(findPassReasonBranch(where), 'the passReason condition should still exist');
});

test('the aim filter still excludes promoted and user-decided jobs', () => {
  const serialised = JSON.stringify(manualScoringStatusWhere('aim'));
  assert.match(serialised, /"fitCategory":\{"not":"promoted"\}/);
  assert.match(serialised, /Promoted by user:/);
  assert.match(serialised, /user_promote/);
  // An explicit rescore still readmits a job the user had already decided on.
  assert.match(serialised, /user_rescore/);
});

test('the aim filter never wraps a nullable string in a bare NOT array', () => {
  const where = manualScoringStatusWhere('aim') as Record<string, unknown>;
  const bareNotArrays: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.NOT)) {
      for (const clause of record.NOT) {
        if (clause && typeof clause === 'object' && 'passReason' in clause) bareNotArrays.push(clause);
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(where);
  assert.deepEqual(bareNotArrays, [], 'passReason must not sit inside a NOT array');
});

test('the experience filter uses the null-safe relation form', () => {
  // `none:` is a relation filter and cannot be swallowed by a null scalar,
  // which is why this stage was never affected.
  const serialised = JSON.stringify(manualScoringStatusWhere('experience'));
  assert.match(serialised, /"none":\{"eventType"/);
  assert.equal(serialised.includes('passReason'), false);
});

test('both stages stay scoped to the pending queue', () => {
  for (const stage of ['aim', 'experience'] as const) {
    assert.equal((manualScoringStatusWhere(stage) as { status?: string }).status, 'pending_af');
  }
});
