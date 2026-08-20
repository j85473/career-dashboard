import assert from 'node:assert/strict';
import test from 'node:test';

import { exactCompanyWhere } from '../../src/lib/jobListQuery';

test('exactCompanyWhere trims the value and requires a case-insensitive exact match', () => {
  assert.deepEqual(exactCompanyWhere('  Target  '), {
    company: { equals: 'Target', mode: 'insensitive' },
  });
});

test('exactCompanyWhere preserves meaningful punctuation', () => {
  assert.deepEqual(exactCompanyWhere('AT&T'), {
    company: { equals: 'AT&T', mode: 'insensitive' },
  });
});

test('exactCompanyWhere rejects an empty company filter', () => {
  assert.equal(exactCompanyWhere(null), null);
  assert.equal(exactCompanyWhere('   '), null);
});
